import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb"
import { loadParams } from "../../shared/ssm.mjs"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const TABLE = process.env.TICKET_TABLE
const NUMBER_TABLE = process.env.TICKET_NUMBER_TABLE
const MAX_AMOUNT = Number(process.env.MAX_AMOUNT)

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const FLEET = ["VV01", "VV02"]
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

// Parse YYYY-MM-DD or M/D/YY[YY] formats. Returns { iso: "YYYY-MM-DD", dateObj: UTC Date }
// for real calendar dates (catches Feb 30, etc.), or { error: "..." }.
const parseDate = (s) => {
  let yyyy, mm, dd
  if (s.includes("-")) {
    ;[yyyy, mm, dd] = s.split("-")
  } else if (s.includes("/")) {
    const [m, d, y] = s.split("/")
    yyyy = y?.length === 2 ? "20" + y : y
    mm = m
    dd = d
  } else {
    return { error: `Invalid date format: ${s}` }
  }
  if (!yyyy || !mm || !dd) return { error: `Invalid date format: ${s}` }
  mm = String(+mm)
  dd = String(+dd)
  const iso = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`
  const dateObj = new Date(Date.UTC(+yyyy, +mm - 1, +dd))
  if (
    dateObj.getUTCFullYear() !== +yyyy ||
    dateObj.getUTCMonth() !== +mm - 1 ||
    dateObj.getUTCDate() !== +dd
  ) {
    return { error: `Date '${iso}' is not a real calendar date` }
  }
  return { iso, dateObj }
}

const lowercaseWords = (s) => s.split(/\s+/).filter((w) => /^[a-z]/.test(w))

const timeToMinutes = (s) => {
  const m = s.match(/^(\d{2}):(\d{2})$/)
  if (!m) return null
  const h = +m[1], min = +m[2]
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

export const handler = async (event) => {
  const { RATE: rateStr } = await loadParams({ RATE: process.env.RATE_PARAM })
  const RATE = Number(rateStr)

  const user = event.requestContext?.authorizer?.lambda?.user
  if (!user) return json(401, { error: "Unauthorized" })

  const ticketId = event.pathParameters?.ticketId
  if (!ticketId) return json(400, { error: "Missing ticketId" })

  let confirmedData
  try {
    confirmedData = JSON.parse(event.body || "{}")
  } catch {
    return json(400, { error: "Invalid JSON body" })
  }

  const REQUIRED_FIELDS = ["ticketNumber", "date", "day", "customerName", "jobName", "start", "stop", "truckNo"]
  const bad = REQUIRED_FIELDS.filter(
    (k) => typeof confirmedData[k] !== "string" || !confirmedData[k].trim()
  )
  if (bad.length) return json(400, { error: "Missing or non-string fields", details: bad })

  const ticketNumber = confirmedData.ticketNumber

  const existing = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { ticketId } }))
  const t = existing.Item
  if (!t) return json(404, { error: "Ticket not found" })
  if (t.userId !== user && user !== "ADMIN") return json(403, { error: "Forbidden" })
  if (t.status !== "extracted") return json(409, { error: `Ticket is in '${t.status}' state, not 'extracted'` })

  const errors = []

  const FORMULA_RE = /^\s*[=+\-@]/
  for (const k of ["customerName", "jobName", "ticketNumber"]) {
    if (FORMULA_RE.test(confirmedData[k])) {
      errors.push(`${k} cannot start with =, +, -, or @`)
    }
  }

  if (!/^\d{4,10}$/.test(confirmedData.ticketNumber)) {
    errors.push("ticketNumber must be 4-10 digits")
  }

  const MAX_LEN = { customerName: 50, jobName: 50 }
  for (const [k, max] of Object.entries(MAX_LEN)) {
    if (confirmedData[k].length > max) {
      errors.push(`${k} exceeds ${max} chars`)
    }
  }

  for (const k of ["customerName", "jobName"]) {
    const bad = lowercaseWords(confirmedData[k])
    if (bad.length) {
      errors.push(`${k} has lowercase words: ${bad.join(", ")}`)
    }
  }

  const dateResult = parseDate(confirmedData.date)
  if (dateResult.error) {
    errors.push(dateResult.error)
  } else {
    confirmedData.date = dateResult.iso
    const expectedDay = DAY_NAMES[dateResult.dateObj.getUTCDay()]
    if (confirmedData.day.toLowerCase() !== expectedDay.toLowerCase()) {
      errors.push(`day '${confirmedData.day}' does not match date (expected ${expectedDay})`)
    } else {
      confirmedData.day = expectedDay
    }
    const now = new Date()
    const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const ticketUTC = dateResult.dateObj.getTime()
    const dayMs = 24 * 60 * 60 * 1000
    if (ticketUTC > todayUTC || ticketUTC < todayUTC - 7 * dayMs) {
      errors.push(`date '${dateResult.iso}' must be within the past 7 days`)
    }
  }

  const startMin = timeToMinutes(confirmedData.start)
  const stopMin = timeToMinutes(confirmedData.stop)
  if (startMin === null) errors.push(`start '${confirmedData.start}' is not a valid HH:MM time`)
  if (stopMin === null) errors.push(`stop '${confirmedData.stop}' is not a valid HH:MM time`)
  if (startMin !== null && stopMin !== null && startMin >= stopMin) {
    errors.push("stop must be after start")
  }

  if (!FLEET.includes(confirmedData.truckNo)) {
    errors.push(`truckNo '${confirmedData.truckNo}' is not in fleet [${FLEET.join(", ")}]`)
  }
  if (user !== "ADMIN" && confirmedData.truckNo !== user) {
    errors.push(`truckNo '${confirmedData.truckNo}' does not match driver '${user}'`)
  }

  if (errors.length) {
    console.log("Validation failed:", ticketId, JSON.stringify(errors))
    return json(400, { error: "Validation failed", details: errors })
  }

  const hours = Math.round(((stopMin - startMin) / 60) * 4) / 4
  const amount = hours * RATE
  if (amount > MAX_AMOUNT) {
    return json(400, { error: `Amount $${amount} exceeds maximum of $${MAX_AMOUNT}` })
  }

  const now = Date.now()

  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { ticketId },
              ConditionExpression: "#status = :extracted",
              UpdateExpression:
                "SET #status = :confirmed, confirmedData = :data, #ts.#confirmedAt = :now, ticketDate = :ticketDate, hours = :hours, amount = :amount, rate = :rate",
              ExpressionAttributeNames: {
                "#status": "status",
                "#ts": "timestamps",
                "#confirmedAt": "confirmedAt",
              },
              ExpressionAttributeValues: {
                ":extracted": "extracted",
                ":confirmed": "confirmed",
                ":data": confirmedData,
                ":now": now,
                ":ticketDate": confirmedData.date,
                ":hours": hours,
                ":amount": amount,
                ":rate": RATE,
              },
            },
          },
          {
            Put: {
              TableName: NUMBER_TABLE,
              Item: { ticketNumber, createdAt: now },
              ConditionExpression: "attribute_not_exists(ticketNumber)",
            },
          },
        ],
      })
    )
  } catch (err) {
    if (err.name === "TransactionCanceledException") {
      const reasons = err.CancellationReasons ?? []
      const ticketConditionFailed = reasons[0]?.Code === "ConditionalCheckFailed"
      const numberConditionFailed = reasons[1]?.Code === "ConditionalCheckFailed"
      if (numberConditionFailed && !ticketConditionFailed) {
        return json(409, { error: `Ticket number ${ticketNumber} has already been filed` })
      }
      return json(409, { error: "Ticket is no longer in 'extracted' state" })
    }
    throw err
  }

  console.log("Confirmed:", ticketId, ticketNumber)
  return json(200, { ticketId, ticketNumber, status: "confirmed", message: `Ticket #${ticketNumber} confirmed.` })
}
