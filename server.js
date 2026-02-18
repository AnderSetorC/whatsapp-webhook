const express = require("express")
const cors = require("cors")
const { createClient } = require("@supabase/supabase-js")

const app = express()

app.use(cors())
app.use(express.json())

// 🔐 Supabase
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

    // 🔎 Buscar regras ativas
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

    // 🧠 Verifica se conversa já existe
    const { data: conversaExistente } = await supabase
      .from("conversas")
      .select("*")
      .eq("telefone", telefone)
      .single()

    let conversaId

    if (!conversaExistente) {
      // 🆕 Nova conversa
      const { data: novaConversa } = await supabase
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

      conversaId = novaConversa.id
    } else {
      conversaId = conversaExistente.id

      let updateData = {}

      // 🔒 ORIGEM só define se ainda não tiver
      if (!conversaExistente.origem && novaOrigem) {
        updateData.origem = novaOrigem
      }

      // 🔁 STATUS sempre atualiza
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

    // 💬 Salvar mensagem
    await supabase.from("mensagens").insert([
      {
        conversa_id: conversaId,
        mensagem,
        origem_mensagem: "cliente"
      }
    ])

    console.log("=== PROCESSADO ===")
    console.log({
      telefone,
      nome,
      mensagem,
      novaOrigem,
      novoStatus
    })

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
