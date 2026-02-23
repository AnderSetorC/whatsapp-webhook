const express = require("express")
const cors = require("cors")
const { createClient } = require("@supabase/supabase-js")

const app = express()

app.use(cors())
app.use(express.json())

// ============================
// CONEXÃO SUPABASE
// ============================

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SECRET_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error("ERRO: SUPABASE_URL ou SUPABASE_SECRET_KEY não configuradas!")
}

const supabase = createClient(
  supabaseUrl || "",
  supabaseKey || ""
)

// ============================
// HEALTH CHECK
// ============================

app.get("/", (req, res) => {
  res.status(200).json({
    status: "online",
    message: "CRM WhatsApp Multi-Cliente ativo",
    version: "3.5"
  })
})

// ============================
// WEBHOOK WHATSAPP
// ============================

app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const body = req.body

    // ============================
    // EXTRAÇÃO DOS DADOS
    // ============================

    let telefone = null

    // Pega o telefone real: prioriza o campo que contém @s.whatsapp.net
    const jid = body?.data?.key?.remoteJid || ""
    const jidAlt = body?.data?.key?.remoteJidAlt || ""
    const participant = body?.data?.key?.participant || ""

    if (jid.includes("@s.whatsapp.net")) {
      telefone = jid
    } else if (jidAlt.includes("@s.whatsapp.net")) {
      telefone = jidAlt
    } else if (participant.includes("@s.whatsapp.net")) {
      // Participant pode ter o número real em alguns casos
      telefone = participant
    } else {
      // Nenhum campo tem número real, usa o que existir (pode ser @lid ou @g.us)
      telefone = jidAlt || jid || body?.from || null
    }

    const nome =
      body?.data?.pushName ||
      body?.pushName ||
      null

    const mensagem =
      body?.data?.message?.conversation ||
      body?.data?.message?.extendedTextMessage?.text ||
      body?.message?.conversation ||
      ""

    // Detecta se a mensagem foi enviada pelo dono da instância
    const fromMe = body?.data?.key?.fromMe || false

    // Se fromMe=true, o pushName é do dono da instância, não do lead
    // Não usar como nome do contato
    const nomeContato = fromMe ? null : nome

    const instanceName = body?.instance || null

    // Log detalhado para debug de telefone
    console.log("=== MENSAGEM RECEBIDA ===")
    console.log("remoteJid:", body?.data?.key?.remoteJid)
    console.log("remoteJidAlt:", body?.data?.key?.remoteJidAlt)
    console.log("participant:", body?.data?.key?.participant)
    console.log("telefone extraído:", telefone)
    console.log("fromMe:", fromMe)
    console.log("isLid:", telefone?.includes("@lid") || false)
    console.log("instanceName:", instanceName)
    console.log("=== FIM ===")

    if (!telefone) {
      return res.status(200).json({ success: true, info: "sem telefone" })
    }

    // ============================
    // IDENTIFICA TIPO DE CONVERSA
    // ============================

    const isGroup = telefone.includes("@g.us")
    const isLid = telefone.includes("@lid")
    const isNewsletter = telefone.includes("newsletter")
    const isStatus = telefone === "status@broadcast"

    if (isStatus || isNewsletter) {
      return res.status(200).json({ success: true, info: "ignorado" })
    }

    // Se é @lid em conversa individual (não grupo), ignorar
    // O próximo webhook virá com o número real
    if (isLid && !isGroup) {
      console.log("Ignorando mensagem @lid individual (aguardando número real):", telefone)
      return res.status(200).json({ success: true, info: "lid ignorado" })
    }

    telefone = telefone
      .replace("@s.whatsapp.net", "")
      .replace("@g.us", "")
      .replace("@lid", "")

    if (isGroup || isLid) {
      const parts = telefone.split("-")
      if (parts.length > 1 && parts[0].match(/^\d{10,15}$/)) {
        telefone = parts[0]
      }
    }

    // Validação: se o número limpo tem mais de 15 dígitos e não é grupo,
    // provavelmente é um ID interno (@lid) que passou sem a tag
    if (!isGroup && telefone.length > 15) {
      console.log("Ignorando número suspeito (muito longo, provável @lid):", telefone)
      return res.status(200).json({ success: true, info: "numero suspeito ignorado" })
    }

    // ============================
    // IDENTIFICA INSTÂNCIA
    // ============================

    let instanciaId = null

    if (instanceName) {
      const { data: instancia } = await supabase
        .from("instancias")
        .select("id")
        .eq("evolution_instance_name", instanceName)
        .maybeSingle()

      if (instancia) {
        instanciaId = instancia.id
      } else {
        console.log("Instância não encontrada:", instanceName)
      }
    }

    // ============================
    // DETECTA SE É GRUPO
    // ============================

    const isGrupo = telefone && (telefone.length > 15 || telefone.startsWith("120"))

    // Verifica configuração de regras para grupos
    let aplicarRegrasGrupo = false
    if (isGrupo && instanciaId) {
      const { data: configGrupo } = await supabase
        .from("configuracoes")
        .select("valor")
        .eq("chave", `aplicar_regras_grupo_${instanciaId}`)
        .maybeSingle()
      aplicarRegrasGrupo = configGrupo?.valor === "true"
    }

    // ============================
    // DETECTA REFERÊNCIA NA MENSAGEM
    // ============================

    let refSource = null
    let refCampaign = null
    let refAd = null
    let refCode = null

    if (mensagem) {
      const refMatch = mensagem.match(/#ref-([\w-]+)/)
      if (refMatch) {
        refCode = refMatch[1]
        const parts = refCode.split("-")
        refSource = parts[0] || null
        refCampaign = parts.slice(1, -1).join("-") || parts[1] || null
        refAd = parts.length > 2 ? parts[parts.length - 1] : null

        // Se tem 2 partes, segunda é campanha (não anúncio)
        if (parts.length === 2) {
          refCampaign = parts[1]
          refAd = null
        }
      }
    }

    // ============================
    // BUSCA REGRAS ATIVAS
    // ============================

    let regrasQuery = supabase
      .from("regras")
      .select("*")
      .eq("ativo", true)

    if (instanciaId) {
      regrasQuery = regrasQuery.or(`instancia_id.eq.${instanciaId},instancia_id.is.null`)
    }

    const { data: regras, error: erroRegras } = await regrasQuery

    if (erroRegras) {
      console.error("Erro ao buscar regras:", erroRegras)
    }

    let novaOrigem = null
    let novoStatus = null

    // Referência do link rastreável tem prioridade sobre regras para origem
    if (refSource) {
      novaOrigem = refSource.toUpperCase().replace(/_/g, " ")
    }

    if (regras && mensagem && !fromMe && (!isGrupo || aplicarRegrasGrupo)) {
      for (const regra of regras) {
        const textoRegra = (regra.texto || "").toLowerCase()
        const msg = mensagem.toLowerCase()

        let bateu = false

        if (regra.modo === "contains") {
          // Suporta múltiplas palavras separadas por vírgula
          // Ex: "valor, preço, quanto custa, comprar" → bate se qualquer uma estiver na mensagem
          const palavras = textoRegra.split(",").map(p => p.trim()).filter(p => p)
          bateu = palavras.some(palavra => msg.includes(palavra))
        }

        if (regra.modo === "word") {
          // Igual ao contains mas verifica palavra inteira (não substring)
          // Ex: "valor" NÃO bate em "valorizou", mas bate em "qual o valor"
          const palavras = textoRegra.split(",").map(p => p.trim()).filter(p => p)
          bateu = palavras.some(palavra => {
            const regex = new RegExp(`\\b${palavra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
            return regex.test(msg)
          })
        }

        if (regra.modo === "exact") {
          // Suporta múltiplos textos exatos separados por vírgula
          const textos = textoRegra.split(",").map(p => p.trim()).filter(p => p)
          bateu = textos.some(texto => msg === texto)
        }

        if (bateu) {
          if (regra.tipo_regra === "ORIGEM" && !novaOrigem) {
            novaOrigem = regra.resultado
          }

          if (regra.tipo_regra === "STATUS") {
            novoStatus = regra.resultado
          }
        }
      }
    }

    // ============================
    // VERIFICA SE CONVERSA EXISTE
    // ============================

    let conversaQuery = supabase
      .from("conversas")
      .select("*")
      .eq("telefone", telefone)

    if (instanciaId) {
      conversaQuery = conversaQuery.eq("instancia_id", instanciaId)
    }

    const { data: conversaExistente, error: erroBusca } = await conversaQuery.maybeSingle()

    if (erroBusca) {
      console.error("Erro ao buscar conversa:", erroBusca)
      throw erroBusca
    }

    let conversaId

    if (!conversaExistente) {
      const novaConversaData = {
        telefone,
        nome: nomeContato || null,
        origem: (isGrupo && !aplicarRegrasGrupo) ? null : (novaOrigem || null),
        status: (isGrupo && !aplicarRegrasGrupo) ? "GRUPO" : (novoStatus || "NOVO"),
        is_grupo: isGrupo || false,
        atualizado_em: new Date().toISOString(),
        instancia_id: instanciaId,
        campanha: refCampaign || null,
        anuncio: refAd || null,
        ref_code: refCode || null
      }

      if (mensagem) {
        novaConversaData.ultima_mensagem = mensagem
      }

      const { data: novaConversa, error } = await supabase
        .from("conversas")
        .insert([novaConversaData])
        .select()
        .single()

      if (error) {
        console.error("Erro ao criar conversa:", error)
        throw error
      }

      conversaId = novaConversa.id

      // Dispara evento Meta se status foi definido
      if (novoStatus && instanciaId) {
        dispararEventoMeta(instanciaId, conversaId, telefone, novoStatus)
          .catch(err => console.error("[META CAPI] Erro async (nova conversa):", err))
      }

    } else {
      conversaId = conversaExistente.id

      const updateData = {}

      // Só aplica origem/status se não for grupo ou se regras de grupo estão ativadas
      if (!isGrupo || aplicarRegrasGrupo) {
        if (!conversaExistente.origem && novaOrigem) {
          updateData.origem = novaOrigem
        }

        if (novoStatus) {
          updateData.status = novoStatus
        }
      }

      if (nomeContato && !conversaExistente.nome) {
        updateData.nome = nomeContato
      }

      // Marca como grupo se ainda não estava marcado
      if (isGrupo && !conversaExistente.is_grupo) {
        updateData.is_grupo = true
      }

      if (mensagem) {
        updateData.ultima_mensagem = mensagem
      }

      // Salva dados de campanha se não tinha
      if (!conversaExistente.campanha && refCampaign) {
        updateData.campanha = refCampaign
      }
      if (!conversaExistente.anuncio && refAd) {
        updateData.anuncio = refAd
      }
      if (!conversaExistente.ref_code && refCode) {
        updateData.ref_code = refCode
      }

      updateData.atualizado_em = new Date().toISOString()

      if (Object.keys(updateData).length > 0) {
        const { error: erroUpdate } = await supabase
          .from("conversas")
          .update(updateData)
          .eq("id", conversaId)

        if (erroUpdate) {
          console.error("Erro ao atualizar conversa:", erroUpdate)
        }

        // Dispara evento Meta se status mudou
        if (updateData.status && instanciaId) {
          dispararEventoMeta(instanciaId, conversaId, telefone, updateData.status)
            .catch(err => console.error("[META CAPI] Erro async (update conversa):", err))
        }
      }
    }

    // ============================
    // SALVA MENSAGEM
    // ============================

    if (mensagem) {
      const { error: erroMensagem } = await supabase
        .from("mensagens")
        .insert([
          {
            telefone,
            mensagem,
            direcao: fromMe ? "saida" : "entrada",
            instancia_id: instanciaId
          }
        ])

      if (erroMensagem) {
        console.error("Erro ao salvar mensagem:", erroMensagem)
        throw erroMensagem
      }
    }

    return res.status(200).json({ success: true })

  } catch (error) {
    console.error("ERRO NO WEBHOOK:", error)

    // Salva erro na tabela de logs para monitoramento
    try {
      await supabase.from("log_erros").insert([{
        tipo: "webhook",
        mensagem: error?.message || String(error),
        detalhes: JSON.stringify({
          stack: error?.stack,
          body_instance: req.body?.instance,
          body_from: req.body?.data?.key?.remoteJid
        }),
        criado_em: new Date().toISOString()
      }])
    } catch (logErr) {
      console.error("Erro ao salvar log de erro:", logErr)
    }

    return res.status(200).json({ success: false, error: "Erro interno" })
  }
})

// ============================================
// MONITORAMENTO DE ERROS
// ============================================

// Retorna erros recentes (últimas 24h)
app.get("/api/erros/recentes", async (req, res) => {
  try {
    const ontem = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const { data: erros, error } = await supabase
      .from("log_erros")
      .select("*")
      .gte("criado_em", ontem)
      .order("criado_em", { ascending: false })
      .limit(50)

    if (error) throw error

    res.json({
      total: erros?.length || 0,
      erros: erros || []
    })
  } catch (error) {
    console.error("Erro ao buscar logs:", error)
    res.status(500).json({ error: "Erro ao buscar logs" })
  }
})

// Limpar erros antigos (mais de 7 dias)
app.delete("/api/erros/limpar", async (req, res) => {
  try {
    const seteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { error } = await supabase
      .from("log_erros")
      .delete()
      .lt("criado_em", seteDiasAtras)

    if (error) throw error

    res.json({ success: true, message: "Erros antigos removidos" })
  } catch (error) {
    res.status(500).json({ error: "Erro ao limpar logs" })
  }
})

// ============================================
// PROXY EVOLUTION API (v2)
// ============================================

// Criar instância
app.post("/api/instance/create", async (req, res) => {
  try {
    const { instanceName, evolutionUrl, evolutionApiKey, clientName } = req.body

    const createResponse = await fetch(`${evolutionUrl}/instance/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": evolutionApiKey
      },
      body: JSON.stringify({
        instanceName,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true
      })
    })

    const createData = await createResponse.json()

    // Se instância já existe na Evolution, não é erro fatal
    if (!createResponse.ok) {
      const errMsg = JSON.stringify(createData).toLowerCase()
      const alreadyExists = errMsg.includes("already") || errMsg.includes("exists") || errMsg.includes("já existe")

      if (!alreadyExists) {
        return res.status(400).json({ error: "Erro ao criar instância", details: createData })
      }

      console.log("Instância já existe na Evolution, continuando:", instanceName)
    }

    // Configura webhook automaticamente
    await fetch(`${evolutionUrl}/webhook/set/${instanceName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": evolutionApiKey
      },
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: "https://whatsapp-webhook-liart.vercel.app/webhook/whatsapp",
          webhookByEvents: false,
          webhookBase64: false,
          events: ["MESSAGES_UPSERT"]
        }
      })
    })

    // Verifica se já existe no Supabase (evita duplicação)
    const { data: existente } = await supabase
      .from("instancias")
      .select("id")
      .eq("evolution_instance_name", instanceName)
      .maybeSingle()

    let instancia = existente

    if (existente) {
      // Já existe: reativa se estava inativa
      const { data: updated, error } = await supabase
        .from("instancias")
        .update({
          nome: clientName || instanceName,
          evolution_url: evolutionUrl,
          evolution_api_key: evolutionApiKey,
          ativo: true,
          atualizado_em: new Date().toISOString()
        })
        .eq("id", existente.id)
        .select()
        .single()

      if (error) console.error("Erro ao atualizar instância:", error)
      instancia = updated || existente
      console.log("Instância já existia no Supabase, atualizada:", instanceName)
    } else {
      // Não existe: cria nova
      const { data: nova, error } = await supabase
        .from("instancias")
        .insert([{
          nome: clientName || instanceName,
          evolution_url: evolutionUrl,
          evolution_api_key: evolutionApiKey,
          evolution_instance_name: instanceName,
          ativo: true
        }])
        .select()
        .single()

      if (error) console.error("Erro ao salvar instância:", error)
      instancia = nova
      console.log("Nova instância criada no Supabase:", instanceName)
    }

    return res.json({
      success: true,
      instance: createData,
      instancia_id: instancia?.id,
      qrcode: createData?.qrcode
    })

  } catch (error) {
    console.error("Erro ao criar instância:", error)
    return res.status(500).json({ error: "Erro interno" })
  }
})

// QR Code para conectar
app.get("/api/instance/connect/:name", async (req, res) => {
  try {
    const { name } = req.params

    const { data: instancia } = await supabase
      .from("instancias")
      .select("*")
      .eq("evolution_instance_name", name)
      .maybeSingle()

    if (!instancia) {
      return res.status(404).json({ error: "Instância não encontrada" })
    }

    // Primeira tentativa: pedir QR normalmente
    const response = await fetch(
      `${instancia.evolution_url}/instance/connect/${name}`,
      { headers: { "apikey": instancia.evolution_api_key } }
    )

    const data = await response.json()
    const qr = data?.base64 || data?.qrcode?.base64 || null

    if (qr) {
      return res.json(data)
    }

    // Se não veio QR, tenta restart da instância e pede QR de novo
    console.log("QR não disponível, tentando restart da instância:", name)

    try {
      await fetch(
        `${instancia.evolution_url}/instance/restart/${name}`,
        {
          method: "PUT",
          headers: { "apikey": instancia.evolution_api_key }
        }
      )

      // Aguarda 2s para a instância reiniciar
      await new Promise(resolve => setTimeout(resolve, 2000))

      const retryResponse = await fetch(
        `${instancia.evolution_url}/instance/connect/${name}`,
        { headers: { "apikey": instancia.evolution_api_key } }
      )

      const retryData = await retryResponse.json()
      return res.json(retryData)

    } catch (restartErr) {
      console.error("Erro no restart:", restartErr)
      // Retorna o resultado original mesmo sem QR
      return res.json(data)
    }

  } catch (error) {
    console.error("Erro ao conectar:", error)
    return res.status(500).json({ error: "Erro interno" })
  }
})

// Status da conexão
app.get("/api/instance/status/:name", async (req, res) => {
  try {
    const { name } = req.params

    const { data: instancia } = await supabase
      .from("instancias")
      .select("*")
      .eq("evolution_instance_name", name)
      .maybeSingle()

    if (!instancia) {
      return res.status(404).json({ error: "Instância não encontrada" })
    }

    const response = await fetch(
      `${instancia.evolution_url}/instance/connectionState/${name}`,
      { headers: { "apikey": instancia.evolution_api_key } }
    )

    const data = await response.json()

    // Se conectou, busca e salva o número
    if (data?.instance?.state === "open" || data?.state === "open") {
      try {
        const infoResponse = await fetch(
          `${instancia.evolution_url}/instance/fetchInstances?instanceName=${name}`,
          { headers: { "apikey": instancia.evolution_api_key } }
        )
        const infoData = await infoResponse.json()
        const numero = infoData?.[0]?.ownerJid ||
                       infoData?.[0]?.instance?.owner ||
                       infoData?.instance?.owner || null

        if (numero) {
          const telefoneConectado = numero.replace("@s.whatsapp.net", "").split(":")[0]
          await supabase
            .from("instancias")
            .update({
              telefone_conectado: telefoneConectado,
              atualizado_em: new Date().toISOString()
            })
            .eq("id", instancia.id)
        }
      } catch (e) {
        console.error("Erro ao buscar número:", e)
      }
    }

    return res.json(data)

  } catch (error) {
    console.error("Erro ao buscar status:", error)
    return res.status(500).json({ error: "Erro interno" })
  }
})

// Desconectar
app.delete("/api/instance/logout/:name", async (req, res) => {
  try {
    const { name } = req.params

    const { data: instancia } = await supabase
      .from("instancias")
      .select("*")
      .eq("evolution_instance_name", name)
      .maybeSingle()

    if (!instancia) {
      return res.status(404).json({ error: "Instância não encontrada" })
    }

    const response = await fetch(
      `${instancia.evolution_url}/instance/logout/${name}`,
      { method: "DELETE", headers: { "apikey": instancia.evolution_api_key } }
    )

    const data = await response.json()

    await supabase
      .from("instancias")
      .update({ telefone_conectado: null, atualizado_em: new Date().toISOString() })
      .eq("id", instancia.id)

    return res.json(data)

  } catch (error) {
    console.error("Erro ao desconectar:", error)
    return res.status(500).json({ error: "Erro interno" })
  }
})

// Reconectar instância (sem precisar escanear QR novamente)
app.put("/api/instance/restart/:name", async (req, res) => {
  try {
    const { name } = req.params

    const { data: instancia } = await supabase
      .from("instancias")
      .select("*")
      .eq("evolution_instance_name", name)
      .maybeSingle()

    if (!instancia) {
      return res.status(404).json({ error: "Instância não encontrada" })
    }

    // Tenta restart na Evolution (mantém sessão, reconecta automaticamente)
    const response = await fetch(
      `${instancia.evolution_url}/instance/restart/${name}`,
      { method: "PUT", headers: { "apikey": instancia.evolution_api_key } }
    )

    const data = await response.json()

    // Aguarda 3s e verifica se reconectou
    await new Promise(resolve => setTimeout(resolve, 3000))

    try {
      const statusRes = await fetch(
        `${instancia.evolution_url}/instance/connectionState/${name}`,
        { headers: { "apikey": instancia.evolution_api_key } }
      )
      const statusData = await statusRes.json()
      const state = statusData?.instance?.state || statusData?.state || "unknown"

      // Se reconectou, busca e salva o número
      if (state === "open") {
        const infoRes = await fetch(
          `${instancia.evolution_url}/instance/fetchInstances?instanceName=${name}`,
          { headers: { "apikey": instancia.evolution_api_key } }
        )
        const infoData = await infoRes.json()
        const numero = infoData?.[0]?.instance?.owner || infoData?.instance?.owner || null

        if (numero) {
          const telefoneConectado = numero.replace("@s.whatsapp.net", "").split(":")[0]
          await supabase
            .from("instancias")
            .update({ telefone_conectado: telefoneConectado, atualizado_em: new Date().toISOString() })
            .eq("id", instancia.id)
        }
      }

      return res.json({ success: true, state, data })

    } catch (statusErr) {
      console.error("Erro ao verificar status após restart:", statusErr)
      return res.json({ success: true, state: "restarting", data })
    }

  } catch (error) {
    console.error("Erro ao reconectar:", error)
    return res.status(500).json({ error: "Erro interno" })
  }
})

// Editar instância (nome, URL, API Key)
app.put("/api/instance/edit/:id", async (req, res) => {
  try {
    const { id } = req.params
    const { nome, evolution_url, evolution_api_key, evolution_instance_name } = req.body

    const { data: instancia } = await supabase
      .from("instancias")
      .select("*")
      .eq("id", id)
      .maybeSingle()

    if (!instancia) {
      return res.status(404).json({ error: "Instância não encontrada" })
    }

    const updateData = { atualizado_em: new Date().toISOString() }

    if (nome !== undefined) updateData.nome = nome
    if (evolution_url !== undefined) updateData.evolution_url = evolution_url
    if (evolution_api_key !== undefined) updateData.evolution_api_key = evolution_api_key
    if (evolution_instance_name !== undefined) updateData.evolution_instance_name = evolution_instance_name

    const { data: updated, error } = await supabase
      .from("instancias")
      .update(updateData)
      .eq("id", id)
      .select()
      .single()

    if (error) {
      console.error("Erro ao editar instância:", error)
      return res.status(400).json({ error: "Erro ao salvar", details: error })
    }

    // Se mudou a URL ou API Key da Evolution, reconfigura o webhook
    if (evolution_url || evolution_api_key) {
      const evoUrl = evolution_url || instancia.evolution_url
      const evoKey = evolution_api_key || instancia.evolution_api_key
      const evoName = evolution_instance_name || instancia.evolution_instance_name

      try {
        await fetch(`${evoUrl}/webhook/set/${evoName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "apikey": evoKey },
          body: JSON.stringify({
            webhook: {
              enabled: true,
              url: "https://whatsapp-webhook-liart.vercel.app/webhook/whatsapp",
              webhookByEvents: false,
              webhookBase64: false,
              events: ["MESSAGES_UPSERT"]
            }
          })
        })
        console.log("Webhook reconfigurado para:", evoName)
      } catch (webhookErr) {
        console.error("Erro ao reconfigurar webhook:", webhookErr)
      }
    }

    return res.json({ success: true, instancia: updated })

  } catch (error) {
    console.error("Erro ao editar instância:", error)
    return res.status(500).json({ error: "Erro interno" })
  }
})

// Deletar instância
app.delete("/api/instance/delete/:name", async (req, res) => {
  try {
    const { name } = req.params

    const { data: instancia } = await supabase
      .from("instancias")
      .select("*")
      .eq("evolution_instance_name", name)
      .maybeSingle()

    if (!instancia) {
      return res.status(404).json({ error: "Instância não encontrada" })
    }

    const response = await fetch(
      `${instancia.evolution_url}/instance/delete/${name}`,
      { method: "DELETE", headers: { "apikey": instancia.evolution_api_key } }
    )

    const data = await response.json()

    await supabase
      .from("instancias")
      .update({ ativo: false, atualizado_em: new Date().toISOString() })
      .eq("id", instancia.id)

    return res.json(data)

  } catch (error) {
    console.error("Erro ao deletar:", error)
    return res.status(500).json({ error: "Erro interno" })
  }
})

// Listar instâncias
app.get("/api/instances", async (req, res) => {
  try {
    const { data: instancias } = await supabase
      .from("instancias")
      .select("*")
      .eq("ativo", true)
      .order("criado_em", { ascending: false })

    return res.json(instancias || [])

  } catch (error) {
    console.error("Erro ao listar:", error)
    return res.status(500).json({ error: "Erro interno" })
  }
})

// ============================================
// PÁGINA DE QR CODE COMPARTILHÁVEL
// ============================================

app.get("/connect/:name", async (req, res) => {
  const { name } = req.params

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conectar WhatsApp</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a1628 0%, #1a2d4a 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
    }
    .container {
      background: rgba(255,255,255,0.08);
      backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 40px;
      max-width: 420px;
      width: 90%;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .logo { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    .subtitle { color: rgba(255,255,255,0.6); font-size: 14px; margin-bottom: 32px; }
    .qr-box {
      background: white;
      border-radius: 16px;
      padding: 20px;
      display: inline-block;
      margin-bottom: 24px;
    }
    .qr-box img { width: 256px; height: 256px; display: block; }
    .badge {
      padding: 12px 24px;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 16px;
    }
    .badge.waiting { background: rgba(255,193,7,0.15); color: #ffc107; border: 1px solid rgba(255,193,7,0.3); }
    .badge.ok { background: rgba(76,175,80,0.15); color: #4caf50; border: 1px solid rgba(76,175,80,0.3); }
    .badge.err { background: rgba(244,67,54,0.15); color: #f44336; border: 1px solid rgba(244,67,54,0.3); }
    .steps { color: rgba(255,255,255,0.5); font-size: 12px; line-height: 1.8; margin-top: 20px; }
    .btn {
      background: rgba(255,255,255,0.1);
      color: white;
      border: 1px solid rgba(255,255,255,0.2);
      padding: 10px 24px;
      border-radius: 12px;
      cursor: pointer;
      font-size: 14px;
      margin-top: 16px;
    }
    .btn:hover { background: rgba(255,255,255,0.2); }
    .spin {
      width: 48px; height: 48px;
      border: 4px solid rgba(255,255,255,0.1);
      border-top: 4px solid #4caf50;
      border-radius: 50%;
      animation: sp 1s linear infinite;
      margin: 20px auto;
    }
    @keyframes sp { to { transform: rotate(360deg); } }
    .hide { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">📱</div>
    <h1>Conecte seu WhatsApp</h1>
    <p class="subtitle">Escaneie o QR Code abaixo com seu WhatsApp</p>

    <div id="load"><div class="spin"></div><p style="color:rgba(255,255,255,0.5)">Gerando QR Code...</p></div>

    <div id="qr" class="hide">
      <div class="qr-box"><img id="qr-img" src="" alt="QR Code"/></div>
      <div class="badge waiting">Aguardando leitura do QR Code...</div>
    </div>

    <div id="ok" class="hide">
      <div style="font-size:64px;margin:20px 0">✅</div>
      <div class="badge ok">WhatsApp conectado com sucesso!</div>
      <p style="color:rgba(255,255,255,0.7);margin-top:8px">Você já pode fechar esta página.</p>
    </div>

    <div id="err" class="hide">
      <div class="badge err" id="err-msg">Erro ao gerar QR Code</div>
      <button class="btn" onclick="go()">Tentar novamente</button>
    </div>

    <div class="steps">
      <p>1. Abra o WhatsApp no celular</p>
      <p>2. Toque em Menu → Aparelhos conectados</p>
      <p>3. Toque em "Conectar aparelho"</p>
      <p>4. Escaneie o QR Code acima</p>
    </div>
  </div>

  <script>
    const N="${name}", B=window.location.origin;
    let iv=null;

    async function go(){
      show("load");
      try{
        const r=await fetch(B+"/api/instance/connect/"+N);
        const d=await r.json();
        const q=d?.base64||d?.qrcode?.base64||null;
        if(q){
          document.getElementById("qr-img").src=q.startsWith("data:")?q:"data:image/png;base64,"+q;
          show("qr");
          check();
        } else throw new Error("QR não disponível");
      }catch(e){
        document.getElementById("err-msg").textContent=e.message||"Erro";
        show("err");
      }
    }

    function check(){
      if(iv)clearInterval(iv);
      iv=setInterval(async()=>{
        try{
          const r=await fetch(B+"/api/instance/status/"+N);
          const d=await r.json();
          if((d?.instance?.state||d?.state)==="open"){
            clearInterval(iv);
            show("ok");
          }
        }catch(e){}
      },5000);
    }

    function show(id){
      ["load","qr","ok","err"].forEach(x=>document.getElementById(x).classList.add("hide"));
      document.getElementById(id).classList.remove("hide");
    }

    go();
    setInterval(()=>{if(!document.getElementById("qr").classList.contains("hide"))go()},45000);
  </script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html")
  return res.send(html)
})

// ============================================
// LINKS RASTREÁVEIS
// ============================================

// Redirecionamento para WhatsApp com rastreamento
app.get("/go/:instancia", async (req, res) => {
  try {
    const { instancia } = req.params
    const { s, c, a, t } = req.query // source, campaign, ad, text

    // Busca instância no banco
    const { data: inst } = await supabase
      .from("instancias")
      .select("*")
      .eq("evolution_instance_name", instancia)
      .eq("ativo", true)
      .maybeSingle()

    if (!inst || !inst.telefone_conectado) {
      return res.status(404).send("Link não encontrado ou WhatsApp não conectado")
    }

    // Monta referência
    let ref = s || "direto"
    if (c) ref += "-" + c
    if (a) ref += "-" + a

    // Monta mensagem
    const texto = t || "Olá! Quero mais informações"
    const mensagem = texto + " #ref-" + ref

    // Incrementa cliques no link
    if (s) {
      const { data: link } = await supabase
        .from("links_rastreavel")
        .select("id, cliques")
        .eq("instancia_id", inst.id)
        .eq("source", s)
        .eq("campaign", c || "")
        .maybeSingle()

      if (link) {
        await supabase
          .from("links_rastreavel")
          .update({ cliques: (link.cliques || 0) + 1 })
          .eq("id", link.id)
      }
    }

    // Redireciona para WhatsApp
    const waUrl = `https://wa.me/${inst.telefone_conectado}?text=${encodeURIComponent(mensagem)}`
    return res.redirect(waUrl)

  } catch (error) {
    console.error("Erro no link rastreável:", error)
    return res.status(500).send("Erro interno")
  }
})

// ============================================
// META CONVERSION API (CAPI)
// ============================================

/**
 * Dispara evento para Meta Conversion API
 * @param {string} instanciaId - UUID da instância
 * @param {string} conversaId - UUID da conversa (pode ser null)
 * @param {string} telefone - Telefone do lead
 * @param {string} estagioNome - Nome do estágio/status atual
 * @returns {object} - Resultado do disparo
 */
async function dispararEventoMeta(instanciaId, conversaId, telefone, estagioNome) {
  try {
    if (!instanciaId || !estagioNome) {
      console.log("[META CAPI] Sem instanciaId ou estagioNome, ignorando")
      return null
    }

    // 1. Busca configuração Meta da instância
    const { data: metaConfig } = await supabase
      .from("meta_config")
      .select("*")
      .eq("instancia_id", instanciaId)
      .eq("ativo", true)
      .maybeSingle()

    if (!metaConfig) {
      console.log("[META CAPI] Sem config Meta para instância:", instanciaId)
      return null
    }

    // 2. Busca mapeamento do estágio para evento Meta
    const { data: mapeamento } = await supabase
      .from("mapeamento_eventos")
      .select("*")
      .eq("instancia_id", instanciaId)
      .eq("estagio_nome", estagioNome)
      .eq("ativo", true)
      .maybeSingle()

    if (!mapeamento) {
      console.log("[META CAPI] Sem mapeamento para estágio:", estagioNome)
      return null
    }

    // 3. Monta payload da Conversion API
    const eventoMeta = mapeamento.evento_meta
    const timestamp = Math.floor(Date.now() / 1000)

    // Formata telefone para padrão E.164 (Brasil)
    let telFormatado = (telefone || "").replace(/\D/g, "")
    if (telFormatado && !telFormatado.startsWith("55")) {
      telFormatado = "55" + telFormatado
    }

    const eventData = {
      data: [
        {
          event_name: eventoMeta,
          event_time: timestamp,
          action_source: "system_generated",
          user_data: {}
        }
      ]
    }

    // Adiciona test_event_code se configurado (para validação no Events Manager)
    if (metaConfig.test_event_code) {
      eventData.test_event_code = metaConfig.test_event_code
    }

    // Adiciona telefone hashado (SHA-256) se disponível
    if (telFormatado) {
      const crypto = require("crypto")
      const phoneHash = crypto
        .createHash("sha256")
        .update(telFormatado)
        .digest("hex")
      eventData.data[0].user_data.ph = [phoneHash]
    }

    // 4. Envia para Meta CAPI
    const capiUrl = `https://graph.facebook.com/v21.0/${metaConfig.pixel_id}/events?access_token=${metaConfig.access_token}`

    console.log(`[META CAPI] Disparando evento "${eventoMeta}" para pixel ${metaConfig.pixel_id}`)
    console.log(`[META CAPI] Telefone: ${telefone}, Estágio: ${estagioNome}`)

    const response = await fetch(capiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventData)
    })

    const statusCode = response.status
    const respBody = await response.text()

    console.log(`[META CAPI] Resposta: ${statusCode} - ${respBody}`)

    // 5. Salva log
    await supabase.from("log_eventos_meta").insert([
      {
        instancia_id: instanciaId,
        conversa_id: conversaId || null,
        telefone: telefone || null,
        evento_meta: eventoMeta,
        estagio_origem: estagioNome,
        status_resposta: statusCode,
        resposta: respBody.substring(0, 1000)
      }
    ])

    return { success: statusCode >= 200 && statusCode < 300, statusCode, evento: eventoMeta }

  } catch (error) {
    console.error("[META CAPI] Erro ao disparar evento:", error)

    // Log de erro
    try {
      await supabase.from("log_eventos_meta").insert([
        {
          instancia_id: instanciaId,
          conversa_id: conversaId || null,
          telefone: telefone || null,
          evento_meta: estagioNome,
          estagio_origem: estagioNome,
          status_resposta: 0,
          resposta: error.message || "Erro desconhecido"
        }
      ])
    } catch (logErr) {
      console.error("[META CAPI] Erro ao salvar log:", logErr)
    }

    return { success: false, error: error.message }
  }
}

// Endpoint para disparo manual (painel arrasta no funil / muda status)
app.post("/api/meta/evento", async (req, res) => {
  try {
    const { instancia_id, conversa_id, telefone, estagio_nome } = req.body

    if (!instancia_id || !estagio_nome) {
      return res.status(400).json({ error: "instancia_id e estagio_nome são obrigatórios" })
    }

    const resultado = await dispararEventoMeta(instancia_id, conversa_id, telefone, estagio_nome)

    if (!resultado) {
      return res.json({ success: true, info: "Sem configuração Meta ou mapeamento para este estágio" })
    }

    return res.json(resultado)

  } catch (error) {
    console.error("Erro no endpoint meta/evento:", error)
    return res.status(500).json({ error: "Erro interno" })
  }
})

// Endpoint para listar logs de eventos Meta
app.get("/api/meta/logs/:instanciaId", async (req, res) => {
  try {
    const { instanciaId } = req.params
    const limit = parseInt(req.query.limit) || 50

    const { data: logs, error } = await supabase
      .from("log_eventos_meta")
      .select("*")
      .eq("instancia_id", instanciaId)
      .order("criado_em", { ascending: false })
      .limit(limit)

    if (error) throw error

    return res.json(logs || [])

  } catch (error) {
    console.error("Erro ao buscar logs Meta:", error)
    return res.status(500).json({ error: "Erro interno" })
  }
})

// ============================
// EXPORTAÇÃO PARA VERCEL
// ============================

module.exports = app
