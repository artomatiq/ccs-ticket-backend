import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb"
import { loadParams } from "../../shared/ssm.mjs"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const TABLE = process.env.TICKET_TABLE
const STATUS_DATE_INDEX = "status-ticketDate-index"
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
    const { date } = body
    if (typeof date !== "string" || !/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid date, expected DD/MM/YYYY" }) }
    }

    const { APPS_SCRIPT_URL } = await loadParams({
        APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL_PARAM,
    })

    let tickets = []
    try {
        const res = await dynamo.send(
            new QueryCommand({
                TableName: TABLE,
                IndexName: STATUS_DATE_INDEX,
                KeyConditionExpression: "#status = :populated AND #ticketDate = :date",
                ExpressionAttributeNames: {
                    "#status": "status",
                    "#ticketDate": "ticketDate",
                },
                ExpressionAttributeValues: {
                    ":populated": "populated",
                    ":date": date,
                },
            })
        )
        if (res.Items) tickets.push(...res.Items)
    } catch (err) {
        console.error(err)
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
    }

    if (tickets.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ error: "No populated tickets for this date" }) }
    }

    const ticketIds = tickets.map((t) => t.ticketId)

    try {
        await dynamo.send(
            new TransactWriteCommand({
                TransactItems: ticketIds.map((ticketId) => ({
                    Update: {
                        TableName: TABLE,
                        Key: { ticketId },
                        UpdateExpression: "SET #status = :generatingInvoice, timestamps.generatingInvoiceTimestamp = :ts",
                        ConditionExpression: "#status = :populated",
                        ExpressionAttributeNames: { "#status": "status" },
                        ExpressionAttributeValues: {
                            ":generatingInvoice": "generatingInvoice",
                            ":populated": "populated",
                            ":ts": new Date().toISOString(),
                        },
                    },
                })),
            })
        )
    } catch (err) {
        if (err.name === "TransactionCanceledException") {
            return {
                statusCode: 409,
                body: JSON.stringify({
                    error: "One or more tickets are already being invoiced or not in 'populated' state. Refresh and retry.",
                }),
            }
        }
        console.error(err)
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
    }

    let invoiceId, pdfUrl
    try {
        const result = await callAppsScript(APPS_SCRIPT_URL, {
            user: "ADMIN",
            date,
            tickets: tickets.map((t) => ({
                ticketId: t.ticketId,
                sheetsRow: t.sheetsRow,
                confirmedData: t.confirmedData,
                hours: t.hours,
                amount: t.amount,
            })),
        })
        invoiceId = result.invoiceId
        pdfUrl = result.pdfUrl
        if (!invoiceId || !pdfUrl) {
            throw new Error(`apps_script_missing_fields: ${JSON.stringify(result).slice(0, 500)}`)
        }
    } catch (err) {
        console.error(err)
        try {
            await dynamo.send(
                new TransactWriteCommand({
                    TransactItems: ticketIds.map((ticketId) => ({
                        Update: {
                            TableName: TABLE,
                            Key: { ticketId },
                            UpdateExpression: "SET #status = :populated, lastInvoiceFailureReason = :reason, timestamps.invoiceFailureTimestamp = :now REMOVE timestamps.generatingInvoiceTimestamp",
                            ConditionExpression: "#status = :generatingInvoice",
                            ExpressionAttributeNames: { "#status": "status" },
                            ExpressionAttributeValues: {
                                ":populated": "populated",
                                ":generatingInvoice": "generatingInvoice",
                                ":reason": err.message.slice(0, 200),
                                ":now": new Date().toISOString(),
                            },
                        },
                    })),
                })
            )
        } catch (revertErr) {
            console.error("Revert failed", revertErr)
        }
        return { statusCode: 502, body: JSON.stringify({ error: err.message }) }
    }

    try {
        await dynamo.send(
            new TransactWriteCommand({
                TransactItems: ticketIds.map((ticketId) => ({
                    Update: {
                        TableName: TABLE,
                        Key: { ticketId },
                        UpdateExpression: "SET #status = :invoiced, invoiceId = :id, invoicePdfUrl = :url, timestamps.invoicedTimestamp = :now",
                        ConditionExpression: "#status = :generatingInvoice",
                        ExpressionAttributeNames: { "#status": "status" },
                        ExpressionAttributeValues: {
                            ":invoiced": "invoiced",
                            ":generatingInvoice": "generatingInvoice",
                            ":id": invoiceId,
                            ":url": pdfUrl,
                            ":now": new Date().toISOString(),
                        },
                    },
                })),
            })
        )
    } catch (err) {
        // Apps Script already produced the PDF; ticket status is stuck at generatingInvoice.
        // Manual reconciliation needed — log enough to trace it.
        console.error("Final status update failed, manual reconciliation required", {
            date, ticketIds, invoiceId, pdfUrl, err: err.message,
        })
    }

    return {
        statusCode: 200,
        body: JSON.stringify({ message: "Invoice generated.", date, ticketIds, invoiceId, pdfUrl }),
    }
}
