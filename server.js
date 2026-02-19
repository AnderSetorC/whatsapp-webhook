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
    message: "Webhook WhatsApp ativo"
  })
})

// ============================
// WEBHOOK WHATSAPP
// ============================

app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const body = req.body

    // Responde rápido para não dar timeout na Evolution API
    // mas continua processando

    // ============================
    // EXTRAÇÃO DOS DADOS
    // ============================

    let telefone =
      body?.data?.key?.remoteJid ||
      body?.from ||
      null

    const nome =
      body?.data?.pushName ||
      body?.pushName ||
      null

    const mensagem =
      body?.data?.message?.conversation ||
      body?.data?.message?.extendedTextMessage?.text ||
      body?.message?.conversation ||
      ""

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

    // Ignora status e newsletters
    if (isStatus || isNewsletter) {
      return res.status(200).json({ success: true, info: "ignorado" })
    }

    // Limpa o telefone removendo sufixos do WhatsApp
    telefone = telefone
      .replace("@s.whatsapp.net", "")
      .replace("@g.us", "")
      .replace("@lid", "")

    // Para grupos/listas (formato: 5514991291256-1560098577), pega só o primeiro número
    if (isGroup || isLid) {
      const parts = telefone.split("-")
      if (parts.length > 1 && parts[0].match(/^\d{10,15}$/)) {
        telefone = parts[0]
      }
    }

    // ============================
    // BUSCA REGRAS ATIVAS
    // ============================

    const { data: regras, error: erroRegras } = await supabase
      .from("regras")
      .select("*")
      .eq("ativo", true)

    if (erroRegras) {
      console.error("Erro ao buscar regras:", erroRegras)
    }

    let novaOrigem = null
    let novoStatus = null

    if (regras && mensagem) {
      for (const regra of regras) {
        const textoRegra = (regra.texto || "").toLowerCase()
        const msg = mensagem.toLowerCase()

        let bateu = false

        if (regra.modo === "contains") {
          bateu = msg.includes(textoRegra)
        }

        if (regra.modo === "exact") {
          bateu = msg === textoRegra
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

    const { data: conversaExistente, error: erroBusca } = await supabase
      .from("conversas")
      .select("*")
      .eq("telefone", telefone)
      .maybeSingle()

    if (erroBusca) {
      console.error("Erro ao buscar conversa:", erroBusca)
      throw erroBusca
    }

    let conversaId

    if (!conversaExistente) {
      // ============================
      // CRIA NOVA CONVERSA
      // ============================

      const novaConversaData = {
        telefone,
        nome: nome || null,
        origem: novaOrigem || null,
        status: novoStatus || "NOVO"
      }

      // Adiciona ultima_mensagem se existir a coluna
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

    } else {
      // ============================
      // ATUALIZA CONVERSA EXISTENTE
      // ============================

      conversaId = conversaExistente.id

      const updateData = {}

      if (!conversaExistente.origem && novaOrigem) {
        updateData.origem = novaOrigem
      }

      if (novoStatus) {
        updateData.status = novoStatus
      }

      if (nome && !conversaExistente.nome) {
        updateData.nome = nome
      }

      if (mensagem) {
        updateData.ultima_mensagem = mensagem
      }

      if (Object.keys(updateData).length > 0) {
        const { error: erroUpdate } = await supabase
          .from("conversas")
          .update(updateData)
          .eq("id", conversaId)

        if (erroUpdate) {
          console.error("Erro ao atualizar conversa:", erroUpdate)
        }
      }
    }

    // ============================
    // SALVA MENSAGEM
    // ============================

    // Tabela mensagens usa: telefone, mensagem, direcao
    // (não usa conversa_id)
    if (mensagem) {
      const { error: erroMensagem } = await supabase
        .from("mensagens")
        .insert([
          {
            telefone,
            mensagem,
            direcao: "entrada"
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
    return res.status(200).json({ success: false, error: "Erro interno" })
  }
})

// ============================
// EXPORTAÇÃO PARA VERCEL
// ============================

module.exports = app
