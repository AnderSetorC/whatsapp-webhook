const express = require("express")
const cors = require("cors")
const { createClient } = require("@supabase/supabase-js")

const app = express()

app.use(cors())
app.use(express.json())

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
)

app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const body = req.body

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

        l
