const express = require("express")
const cors = require("cors")
const { createClient } = require("@supabase/supabase-js")

const app = express()

app.use(cors())
app.use(express.json())

// 🔐 Conexão Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
)

app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const body = req.body

    let telefone = body?.data?.key?.remoteJid || body?.from || null
    const nome = body?.pushName || null
    const mensagem =
      body?.data?.message?.conversation ||
      body?.message?.conversation ||
      ""

    if (telefone) {
      telefone = telefone.replace("@s.whatsapp.net", "")
    }

    // 🔎 Buscar regras no banco
    const { data: regras } = await supabase
      .from("regras")
      .select("*")

    let etiqueta = "DESCONHECIDO"

    if (regras) {
      for (let regra of regras) {
        if (regra.tipo === "exata" && mensagem === regra.palavra_chave) {
          etiqueta = regra.etiqueta
          break
        }

        if (
          regra.tipo === "contem" &&
          mensagem.toLowerCase().includes(regra.palavra_chave.toLowerCase())
        ) {
          etiqueta = regra.etiqueta
          break
        }
      }
    }

    // 🧠 Verifica se conversa já existe
    const { data: conversaExistente } = await supabase
      .from("conversas")
      .select("*")
      .eq("telefone", telefone)
      .single()

    let conversaId

    if (!conversaExistente) {
      const { data: novaConversa } = await supabase
        .from("conversas")
        .insert([
          {
            telefone,
            nome,
            status: etiqueta
          }
        ])
        .select()
        .single()

      conversaId = novaConversa.id
    } else {
      conversaId = conversaExistente.id

      await supabase
        .from("conversas")
        .update({ status: etiqueta })
        .eq("id", conversaId)
    }

    // 💬 Salvar mensagem
    await supabase.from("mensagens").insert([
      {
        conversa_id: conversaId,
        mensagem,
        origem: "cliente"
      }
    ])

    console.log("=== SALVO NO BANCO ===")
    console.log({ telefone, nome, mensagem, etiqueta })

    res.status(200).json({ success: true })
  } catch (error) {
    console.error("ERRO NO WEBHOOK:", error)
    res.status(500).json({ error: "Erro interno" })
  }
})

app.get("/", (req, res) => {
  res.send("Webhook rodando 🚀")
})

app.listen(3000, () => {
  console.log("Servidor rodando na porta 3000")
})
