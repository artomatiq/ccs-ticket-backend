import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, BatchGetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb"
import { loadParams } from "../../shared/ssm.mjs"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const TABLE = process.env.TICKET_TABLE
const APPS_SCRIPT_TIMEOUT_MS = 25000

const callAppsScript = async (url, payload) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), APPS_SCRIPT_TIMEOUT_MS)
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            redirect: "follow",
            signal: controller.signal,
        })
        const text = await res.text()
        if (!res.ok) throw new Error(`apps_script_http_${res.status}: ${text.slice(0, 500)}`)
        const parsed = JSON.parse(text)
        if (parsed.error || parsed.ok === false) {
            throw new Error(`apps_script_returned_error: ${JSON.stringify(parsed).slice(0, 500)}`)
        }
        return parsed
    } finally {
        clearTimeout(timer)
    }
}

export const handler = async (event) => {
    const claims = event?.requestContext?.authorizer?.lambda || {}
    if (claims.user !== "ADMIN") {
        return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) }
    }

    let body
    try {
        body = typeof event.body === "string" ? JSON.parse(event.body) : (event.body || {})
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }
    }

    const { date, ticketIds } = body

    const { APPS_SCRIPT_URL, ADMIN_SECRET } = await loadParams({
        APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL_PARAM,
        ADMIN_SECRET: process.env.ADMIN_SECRET_PARAM,
    })

    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid date, expected YYYY-MM-DD" }) }
    }
    if (!Array.isArray(ticketIds) || ticketIds.length === 0 || ticketIds.some((id) => typeof id !== "string")) {
        return { statusCode: 400, body: JSON.stringify({ error: "ticketIds must be a non-empty array of strings" }) }
    }

    let tickets = []
    try {
        const res = await dynamo.send(
            new BatchGetCommand({
                RequestItems: {
                    [TABLE]: { Keys: ticketIds.map((id) => ({ ticketId: id })) },
                },
            })
        )
        tickets = res.Responses?.[TABLE] ?? []
    } catch (err) {
        console.error(err)
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
    }

    if (tickets.length !== ticketIds.length) {
        return { statusCode: 404, body: JSON.stringify({ error: "One or more tickets not found" }) }
    }

    const wrongDate = tickets.filter((t) => t.ticketDate !== date)
    if (wrongDate.length > 0) {
        return { statusCode: 409, body: JSON.stringify({ error: "One or more tickets do not match the requested date" }) }
    }

    let invoiceId, pdfUrl, alreadyProcessed, messages
    try {
        const [y, m, d] = date.split("-")
        const sheetDate = `${Number(m)}/${Number(d)}/${y}`
        const result = await callAppsScript(APPS_SCRIPT_URL, {
            secret: ADMIN_SECRET,
            date: sheetDate,
            tickets: tickets.map((t) => ({
                ticketId: t.ticketId,
                truckNo: t.confirmedData?.truckNo,
                ticketNumber: t.confirmedData?.ticketNumber,
                customerName: t.confirmedData?.customerName,
                jobName: t.confirmedData?.jobName,
                rate: t.rate,
                hours: t.hours,
                amount: t.amount,
            })),
        })
        invoiceId = result.invoiceId
        pdfUrl = result.pdfUrl
        alreadyProcessed = result.alreadyProcessed ?? false
        messages = result.messages ?? []
        if (!invoiceId || !pdfUrl) {
            throw new Error(`apps_script_missing_fields: ${JSON.stringify(result).slice(0, 500)}`)
        }
    } catch (err) {
        console.error(err)
        return { statusCode: 502, body: JSON.stringify({ error: err.message }) }
    }

    console.log("Sheet write succeeded", { date, ticketIds, invoiceId, pdfUrl })

    if (alreadyProcessed) {
        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Invoice already processed.", date, ticketIds, invoiceId, pdfUrl, messages }),
        }
    }

    try {
        await dynamo.send(
            new TransactWriteCommand({
                TransactItems: ticketIds.map((ticketId) => ({
                    Update: {
                        TableName: TABLE,
                        Key: { ticketId },
                        UpdateExpression: "SET #status = :invoiced, invoiceId = :id, invoicePdfUrl = :url, timestamps.invoicedTimestamp = :now",
                        ConditionExpression: "#status = :populated",
                        ExpressionAttributeNames: { "#status": "status" },
                        ExpressionAttributeValues: {
                            ":invoiced": "invoiced",
                            ":populated": "populated",
                            ":id": invoiceId,
                            ":url": pdfUrl,
                            ":now": new Date().toISOString(),
                        },
                    },
                })),
            })
        )
    } catch (err) {
        // Sheet already updated; invoice PDF exists. Manual reconciliation needed.
        console.error("DynamoDB update failed after sheet write succeeded — manual reconciliation required", {
            date, ticketIds, invoiceId, pdfUrl, err: err.message,
        })
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Invoice generated. Ticket status update failed — update statuses manually.",
                date, ticketIds, invoiceId, pdfUrl, messages,
                warning: err.message,
            }),
        }
    }

    return {
        statusCode: 200,
        body: JSON.stringify({ message: "Invoice generated.", date, ticketIds, invoiceId, pdfUrl, messages }),
    }
}
