const express = require("express")
const cors = require("cors")

const app = express()

app.use(cors())
app.use(express.json())

app.post("/webhook/whatsapp", (req, res) => {
  try {
    const body = req.body

    console.log("=== BODY COMPLETO RECEBIDO ===")
    console.log(JSON.stringify(body, null, 2))

    // 🔹 Tentativa 1: formato simples (teste manual)
    let telefone = body.from
    let nome = body.pushName
    let mensagem = body.message?.conversation

    // 🔹 Tentativa 2: formato Evolution (mais comum)
    if (body?.data?.key?.remoteJid) {
      telefone = body.data.key.remoteJid
    }

    if (body?.data?.pushName) {
      nome = body.data.pushName
    }

    if (body?.data?.message?.conversation) {
      mensagem = body.data.message.conversation
    }

    if (body?.data?.message?.extendedTextMessage?.text) {
      mensagem = body.data.message.extendedTextMessage.text
    }

    mensagem = mensagem || ""

    let etiqueta = "NÃO RASTREADA"

    if (/vim pelo site/i.test(mensagem)) {
      etiqueta = "SITE OFICIAL"
    }

    console.log("=== PROCESSADO ===")
    console.log({
      telefone,
      nome,
      mensagem,
      etiqueta
    })

    res.status(200).json({ success: true })

  } catch (error) {
    console.error("ERRO NO WEBHOOK:", error)
    res.status(500).json({ error: "Erro interno" })
  }
})

module.exports = app
