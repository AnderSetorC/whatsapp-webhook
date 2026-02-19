const express = require("express")
const cors = require("cors")
const { createClient } = require("@supabase/supabase-js")

const app = express()

app.use(cors())
app.use(express.json())

// ============================
// CONEXÃO SUPABASE
// ============================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
)

// ============================
// WEBHOOK WHATSAPP
// ============================

app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const body = req.body

    // ============================
    // EXTRAÇÃO DOS DADOS
    // ============================

    let telefone =
      body?.data?.key?.remoteJid ||
      body?.from ||
      null

    const nome =
      body?.pushName ||
      null

    const mensagem =
      body?.data?.message?.conversation ||
      body?.message?.conversation ||
      ""

    if (telefone) {
      telefone = telefone.replace("@s.whatsapp.net", "")
    }

    if (!telefone) {
      return res.status(200).json({ success: true })
    }

    // ============================
    // BUSCA REGRAS ATIVAS
    // ============================

    const { data: regras } = await supabase
      .from("regras")
      .select("*")
      .eq("ativo", true)

    let novaOrigem = null
    let novoStatus = null

    if (regras && mensagem) {
      for (let regra of regras) {
        const textoRegra = regra.texto.toLowerCase()
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

    const { data: conversaExistente } = await supabase
      .from("conversas")
      .select("*")
      .eq("telefone", telefone)
      .maybeSingle()

    let conversaId

    if (!conversaExistente) {
      // CRIA NOVA CONVERSA

      const { data: novaConversa, error } = await supabase
        .from("conversas")
        .insert([
          {
            telefone,
            nome,
            origem: novaOrigem,
            status: novoStatus || "NOVO"
          }
        ])
        .select()
        .single()

      if (error) {
        console.error("Erro ao criar conversa:", error)
        throw error
      }

      conversaId = novaConversa.id

    } else {
      // ATUALIZA CONVERSA EXISTENTE

      conversaId = conversaExistente.id

      let updateData = {}

      if (!conversaExistente.origem && novaOrigem) {
        updateData.origem = novaOrigem
      }

      if (novoStatus) {
        updateData.status = novoStatus
      }

      if (Object.keys(updateData).length > 0) {
        await supabase
          .from("conversas")
          .update(updateData)
          .eq("id", conversaId)
      }
    }

    // ============================
    // SALVA MENSAGEM
    // ============================

    const { error: erroMensagem } = await supabase
      .from("mensagens")
      .insert([
        {
          conversa_id: conversaId,
          mensagem,
          origem_mensagem: "cliente"
        }
      ])

    if (erroMensagem) {
      console.error("Erro ao salvar mensagem:", erroMensagem)
      throw erroMensagem
    }

    return res.status(200).json({ success: true })

  } catch (error) {
    console.error("ERRO NO WEBHOOK:", error)
    return res.status(500).json({ error: "Erro interno" })
  }
})

// ============================
// EXPORTAÇÃO PARA VERCEL
// ============================

module.exports = (req, res) => {
  app(req, res)
}
