const express = require("express")
const cors = require("cors")

const app = express()

app.use(cors())
app.use(express.json())

app.post("/webhook/whatsapp", (req, res) => {
  const body = req.body

  const telefone = body.from
  const nome = body.pushName
  const mensagem = body.message?.conversation || ""

  let etiqueta = "NÃO RASTREADA"

  if (/vim pelo site/i.test(mensagem)) {
    etiqueta = "SITE OFICIAL"
  }

  console.log({
    telefone,
    nome,
    mensagem,
    etiqueta
  })

  res.status(200).json({ success: true })
})

module.exports = app
