import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb"
import { TextractClient, AnalyzeDocumentCommand } from "@aws-sdk/client-textract"
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const textract = new TextractClient({})
const s3 = new S3Client({})

const TABLE = process.env.TICKET_TABLE

const nameCorrections = {
  faulcomer: "Faulconer",
}

const streamToBuffer = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const capitalizeFirst = (str) =>
  str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : str

const capitalizeWords = (str) =>
  str
    ? str
        .toLowerCase()
        .split(" ")
        .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : ""))
        .join(" ")
    : str

const parseTime = (time) => {
  if (!time) return null
  time = time.toLowerCase().trim()
  time = time
    .replace(/\s+/g, "")
    .replace(/\./g, ":")
    .replace(/(am|pm)\1+/g, "$1")

  let match = time.match(/^(\d{1,2})(?::(\d{1,2}))?(am|pm)$/)
  if (match) {
    let [, h, m, p] = match
    h = parseInt(h)
    m = parseInt(m ?? "0")
    if (h > 12 || m > 59) return null
    if (p === "pm" && h !== 12) h += 12
    if (p === "am" && h === 12) h = 0
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`
  }

  match = time.match(/^(\d{1,2}):(\d{1,2})$/)
  if (match) {
    let [, h, m] = match
    h = parseInt(h)
    m = parseInt(m)
    if (h > 23 || m > 59) return null
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`
  }
  return null
}

export const handler = async (event) => {
  const ticketId = event.detail.ticketId
  const ticketNumber = event.detail.ticketNumber
  const bucket = event.detail.bucket
  const validatedKey = event.detail.validatedKey
  console.log("TicketTextract triggered:", ticketId)

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { ticketId },
        UpdateExpression: "SET #status = :extracting, #ts.#extractingAt = :now",
        ConditionExpression: "#status = :validated",
        ExpressionAttributeNames: {
          "#status": "status",
          "#ts": "timestamps",
          "#extractingAt": "extractingAt",
        },
        ExpressionAttributeValues: {
          ":extracting": "extracting",
          ":validated": "validated",
          ":now": Date.now(),
        },
      })
    )
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log("Ticket not in 'validated' state, ignoring:", ticketId)
      return
    }
    throw err
  }

  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: validatedKey }))
    const imgBuffer = await streamToBuffer(obj.Body)

    const textractRes = await textract.send(
      new AnalyzeDocumentCommand({
        Document: { Bytes: imgBuffer },
        FeatureTypes: ["FORMS"],
      })
    )

    const blocks = textractRes.Blocks || []
    const kvBlocks = blocks.filter((b) => b.BlockType === "KEY_VALUE_SET")
    const keyMap = {}
    const valueMap = {}
    kvBlocks.forEach((b) => {
      if (b.EntityTypes?.includes("KEY")) keyMap[b.Id] = b
      if (b.EntityTypes?.includes("VALUE")) valueMap[b.Id] = b
    })

    const textOf = (block) => {
      if (block?.Text) return block.Text
      const childIds = block?.Relationships?.find((r) => r.Type === "CHILD")?.Ids || []
      return childIds.map((id) => blocks.find((b) => b.Id === id)?.Text).filter(Boolean).join(" ")
    }

    const kvMap = {}
    for (const keyId in keyMap) {
      const keyBlock = keyMap[keyId]
      const valueId = keyBlock.Relationships?.find((r) => r.Type === "VALUE")?.Ids?.[0]
      if (valueId && valueMap[valueId]) {
        const keyText = textOf(keyBlock)
        const valueText = textOf(valueMap[valueId])
        if (keyText && valueText) {
          kvMap[keyText.trim()] = {
            text: valueText.trim(),
            confidence: valueMap[valueId].Confidence || 0,
            Geometry: valueMap[valueId].Geometry || null,
          }
        }
      }
    }

    const normalizedKvMap = {}
    for (const [k, v] of Object.entries(kvMap)) {
      const normKey = k.toLowerCase().replace(/[^a-z0-9]/g, "")
      normalizedKvMap[normKey] = v
    }

    console.log(
      "Textract raw KV map:",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(normalizedKvMap).map(([k, v]) => [k, { text: v.text, confidence: Math.round(v.confidence) }])
        )
      )
    )

    const extracted = {
      ticketNumber,
      date: normalizedKvMap["date"]?.text || "",
      day: normalizedKvMap["day"]?.text || "",
      customerName: normalizedKvMap["customername"]?.text || "",
      jobName: normalizedKvMap["jobname"]?.text || "",
      city: normalizedKvMap["city"]?.text || "",
      truckNo: normalizedKvMap["truckno"]?.text || "",
      start: normalizedKvMap["start"]?.text || "",
      stop: normalizedKvMap["stop"]?.text || "",
    }

    const confidence = {
      date: Math.round(normalizedKvMap["date"]?.confidence || 0),
      day: Math.round(normalizedKvMap["day"]?.confidence || 0),
      customerName: Math.round(normalizedKvMap["customername"]?.confidence || 0),
      jobName: Math.round(normalizedKvMap["jobname"]?.confidence || 0),
      city: Math.round(normalizedKvMap["city"]?.confidence || 0),
      truckNo: Math.round(normalizedKvMap["truckno"]?.confidence || 0),
      start: Math.round(normalizedKvMap["start"]?.confidence || 0),
      stop: Math.round(normalizedKvMap["stop"]?.confidence || 0),
    }

    const getTopRightPoint = (entry) => {
      const point = entry?.Geometry?.Polygon?.[1]
      if (!point) return null
      return [Number(point.X.toFixed(2)), Number(point.Y.toFixed(2))]
    }

    const apex = {
      date: getTopRightPoint(normalizedKvMap["date"]),
      day: getTopRightPoint(normalizedKvMap["day"]),
      customerName: getTopRightPoint(normalizedKvMap["customername"]),
      jobName: getTopRightPoint(normalizedKvMap["jobname"]),
      city: getTopRightPoint(normalizedKvMap["city"]),
      truckNo: getTopRightPoint(normalizedKvMap["truckno"]),
      start: getTopRightPoint(normalizedKvMap["start"]),
      stop: getTopRightPoint(normalizedKvMap["stop"]),
    }

    if (extracted.customerName) {
      const key = extracted.customerName.toLowerCase()
      if (nameCorrections[key]) extracted.customerName = nameCorrections[key]
    }

    if (extracted.date) {
      extracted.date = extracted.date
        .replace(/\./g, "/")
        .replace(/-/g, "/")
        .replace(/\s+/g, "")
        .trim()
    }

    if (extracted.day) {
      extracted.day = capitalizeFirst(extracted.day.toLowerCase().replace(/\s+/g, ""))
    }
    if (extracted.customerName) extracted.customerName = capitalizeWords(extracted.customerName)
    if (extracted.jobName) extracted.jobName = capitalizeWords(extracted.jobName).replace(/#\s+/g, "#")
    if (extracted.city) extracted.city = capitalizeWords(extracted.city)

    if (extracted.start) {
      const parsed = parseTime(extracted.start)
      if (parsed) extracted.start = parsed
    }
    if (extracted.stop) {
      const parsed = parseTime(extracted.stop)
      if (parsed) extracted.stop = parsed
    }

    if (extracted.truckNo) {
      extracted.truckNo = extracted.truckNo
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .replace(/O/g, "0")
        .replace(/I/g, "1")
        .replace(/L/g, "1")
    }

    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { ticketId },
        UpdateExpression: "SET #status = :extracted, #ts.#extractedAt = :now, extractedData = :data, extractionConfidence = :confidence, extractionApex = :apex",
        ConditionExpression: "#status = :extracting",
        ExpressionAttributeNames: {
          "#status": "status",
          "#ts": "timestamps",
          "#extractedAt": "extractedAt",
        },
        ExpressionAttributeValues: {
          ":extracting": "extracting",
          ":extracted": "extracted",
          ":now": Date.now(),
          ":data": extracted,
          ":confidence": confidence,
          ":apex": apex,
        },
      })
    )

    console.log("Extracted:", ticketId)
  } catch (err) {
    console.error(err)
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { ticketId },
          UpdateExpression: "SET #status = :failed, #ts.#failedAt = :now, statusMessage = :msg",
          ConditionExpression: "#status = :extracting",
          ExpressionAttributeNames: {
            "#status": "status",
            "#ts": "timestamps",
            "#failedAt": "failedAt",
          },
          ExpressionAttributeValues: {
            ":failed": "failed",
            ":extracting": "extracting",
            ":now": Date.now(),
            ":msg": err?.message || "extraction failed",
          },
        })
      )
    } catch (e) {
      console.error("failed to mark status as failed:", e)
    }
    throw err
  }
}
