// =====================
// API
// =====================

function doPost(e) {
  console.log('doPost triggered')
  const lock = LockService.getScriptLock()
  try {
    lock.waitLock(10000)
  } catch (_) {
    return jsonResponse({ error: "Script is busy, please retry in a moment" }, 503)
  }
  try {
    const body = JSON.parse(e.postData.contents)
    const { secret, date, tickets } = body

    const expectedSecret = PropertiesService.getScriptProperties().getProperty('ADMIN_SECRET')
    if (!secret || !expectedSecret || secret !== expectedSecret) {
      return jsonResponse({ error: "Unauthorized" }, 403)
    }
    if (!date || typeof date !== "string") {
      return jsonResponse({ error: "date required" }, 400)
    }
    if (!tickets || !Array.isArray(tickets) || tickets.length === 0) {
      return jsonResponse({ error: "tickets array required" }, 400)
    }

    const result = generateInvoice(date, tickets)
    return jsonResponse({ ok: true, ...result })
  } catch (err) {
    console.error('generateInvoice error:', err.message)
    return jsonResponse({ error: err.message }, 500)
  } finally {
    lock.releaseLock()
  }
}

function jsonResponse(data, status = 200) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON)
}

// =====================
// NORMALIZE
// =====================
const normalize = (label, val) => {
  if (val == null) return ""
  let s = String(val)
    .replace(/ /g, "")
    .replace(/ /g, "")
    .trim()
  switch (label) {
    case "date": {
      const parts = s.split("/")
      if (parts.length !== 3) return s
      let [m, d, y] = parts
      m = m.padStart(2, "0")
      d = d.padStart(2, "0")
      if (y.length === 4) y = y.slice(2)
      return `${m}/${d}/${y}`
    }
    case "start":
    case "stop": {
      s = s.toLowerCase()
      const match = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/)
      if (!match) return s
      let [_, h, m, ap] = match
      h = parseInt(h)
      if (ap === "pm" && h !== 12) h += 12
      if (ap === "am" && h === 12) h = 0
      return `${String(h).padStart(2, "0")}:${m}`
    }
    case "hours":
      return String(parseFloat(s))
    case "amount":
    case "rate":
      return String(parseFloat(s.replace(/[$,]/g, "")))
    default:
      return s.trim()
  }
}

// =====================
// CORE LOGIC
// =====================
function generateInvoice(date, requestTickets) {
  const messages = []
  const normalizedRequestDate = normalize("date", date)

  // 1. Fetch all rows for the date
  const lastRow = invoiceSheet.getLastRow()
  if (lastRow < 2) throw new Error("Sheet has no data rows")

  const colCount = getCol("truckNo")
  const allData = invoiceSheet.getRange(2, 1, lastRow - 1, colCount).getDisplayValues()

  const matchedRows = []
  for (let i = 0; i < allData.length; i++) {
    const values = allData[i]
    if (normalize("date", values[getCol("date") - 1]) === normalizedRequestDate) {
      matchedRows.push({ rowNum: i + 2, values })
    }
  }

  if (matchedRows.length === 0) {
    throw new Error(`No sheet rows found for date ${date}`)
  }

  // 2. Group by ticket number, handle duplicates
  const byTicketNum = {}
  for (const r of matchedRows) {
    const ticketNum = normalize("ticketNumber", r.values[getCol("ticketNumber") - 1])
    if (!byTicketNum[ticketNum]) byTicketNum[ticketNum] = []
    byTicketNum[ticketNum].push(r)
  }

  const canonicalRows = []
  for (const [ticketNum, rows] of Object.entries(byTicketNum)) {
    if (rows.length === 1) {
      canonicalRows.push(rows[0])
      continue
    }
    const reqTicket = requestTickets.find(
      t => normalize("ticketNumber", String(t.ticketNumber)) === ticketNum
    )
    if (!reqTicket) {
      throw new Error(
        `Duplicate ticket number ${ticketNum} in sheet rows [${rows.map(r => r.rowNum).join(",")}] not found in request — manual intervention required`
      )
    }
    const matching = rows.filter(r => rowMatchesTicket(r, reqTicket))
    if (matching.length === 0) {
      throw new Error(
        `Duplicate ticket number ${ticketNum}: no sheet row matches request data — ` +
        `rows [${rows.map(r => r.rowNum).join(",")}] — manual intervention required`
      )
    }
    const canonical = matching[0]
    canonicalRows.push(canonical)
    const duplicateRows = rows.filter(r => r.rowNum !== canonical.rowNum)
    for (const dup of duplicateRows) {
      const cell = invoiceSheet.getRange(dup.rowNum, getCol("notes"))
      cell.setValue("duplicate")
      cell.setFontColor("#FF0000")
    }
    messages.push(
      `Duplicate ticket ${ticketNum}: canonical row ${canonical.rowNum}, marked duplicates at rows [${duplicateRows.map(r => r.rowNum).join(",")}]`
    )
  }

  // 3. Validate canonical rows against request data
  for (const row of canonicalRows) {
    const ticketNum = normalize("ticketNumber", row.values[getCol("ticketNumber") - 1])
    const reqTicket = requestTickets.find(
      t => normalize("ticketNumber", String(t.ticketNumber)) === ticketNum
    )
    if (!reqTicket) {
      const alreadyInvoicedNums = canonicalRows
        .filter(r => String(r.values[INVOICE_COL - 1]).trim().length > 0)
        .map(r => `#${normalize("ticketNumber", r.values[getCol("ticketNumber") - 1])}`)
      if (alreadyInvoicedNums.length > 0) {
        throw new Error(
          `For date ${date}, already invoiced: ${alreadyInvoicedNums.join(", ")}—manual intervention on Sheet required.`
        )
      }
      throw new Error(
        `Sheet row ${row.rowNum} (ticket #${ticketNum}) has no matching request ticket — manual intervention required`
      )
    }
    const mismatches = getFieldMismatches(row, reqTicket)
    if (mismatches.length > 0) {
      throw new Error(
        `Row ${row.rowNum} validation failed: ${JSON.stringify(mismatches)} — manual intervention required`
      )
    }
  }

  // 4. Verify every request ticket was found in the sheet
  for (const reqTicket of requestTickets) {
    const ticketNum = normalize("ticketNumber", String(reqTicket.ticketNumber))
    const found = canonicalRows.some(
      r => normalize("ticketNumber", r.values[getCol("ticketNumber") - 1]) === ticketNum
    )
    if (!found) {
      throw new Error(
        `Request ticket ${ticketNum} not found in sheet for date ${date} — manual intervention required`
      )
    }
  }

  // 5. Check invoice column for already-processed idempotency
  const invoicedCells = canonicalRows.map(r => ({
    rowNum: r.rowNum,
    value: String(invoiceSheet.getRange(r.rowNum, INVOICE_COL).getDisplayValue()).trim(),
  }))
  const alreadyInvoiced = invoicedCells.filter(c => c.value.length > 0)

  if (alreadyInvoiced.length > 0) {
    if (alreadyInvoiced.length === canonicalRows.length) {
      const uniqueIds = [...new Set(alreadyInvoiced.map(c => c.value))]
      if (uniqueIds.length === 1) {
        const existingId = uniqueIds[0]
        const formula = invoiceSheet.getRange(canonicalRows[0].rowNum, INVOICE_COL).getFormula()
        const urlMatch = formula.match(/=HYPERLINK\("([^"]+)"/)
        const pdfUrl = urlMatch ? urlMatch[1] : ""
        messages.push(`Already invoiced as ${existingId}`)
        return { invoiceId: existingId, pdfUrl, alreadyProcessed: true, messages }
      }
      throw new Error(
        `All rows already invoiced but with different IDs: ${uniqueIds.join(", ")} — manual intervention required`
      )
    }
    const uninvoicedRows = invoicedCells.filter(c => c.value.length === 0).map(c => c.rowNum)
    throw new Error(
      `Partial invoice state: rows [${uninvoicedRows.join(",")}] are uninvoiced while others are already invoiced — manual intervention required`
    )
  }

  // 6. Compute new invoice number via MAX scan
  const yearPrefix = `${new Date().getFullYear().toString().slice(2)}DT`
  const allInvoiceDisplayValues = invoiceSheet
    .getRange(2, INVOICE_COL, lastRow - 1, 1)
    .getDisplayValues()
    .flat()
    .map(v => String(v).trim())
  const existingNums = allInvoiceDisplayValues
    .filter(v => v.startsWith(yearPrefix) && /^\d+$/.test(v.slice(yearPrefix.length)))
    .map(v => parseInt(v.slice(yearPrefix.length), 10))
  const maxNum = existingNums.length > 0 ? Math.max(...existingNums) : -1
  const newInvoiceId = yearPrefix + String(maxNum + 1).padStart(3, "0")

  // 7. Generate PDF, upload to Drive, and link in sheet (cleanup on any failure)
  const rowNums = canonicalRows.map(r => r.rowNum)
  let pdfUrl
  try {
    pdfUrl = sheetsTemplate(rowNums, newInvoiceId)
    for (const r of canonicalRows) {
      const cell = invoiceSheet.getRange(r.rowNum, INVOICE_COL)
      cell.setFormula(`=HYPERLINK("${pdfUrl}", "${newInvoiceId}")`)
      cell.setFontColor('#1155CC')
      cell.setFontLine('underline')
    }
    SpreadsheetApp.flush()
  } catch (err) {
    try { cleanupDriveFile(newInvoiceId) } catch (e) { console.error('Drive cleanup failed:', e.message) }
    throw new Error(`Invoice generation failed: ${err.message}`)
  }

  return { invoiceId: newInvoiceId, pdfUrl, messages }
}

// =====================
// HELPERS
// =====================
function getFieldMismatches(row, reqTicket) {
  const values = row.values
  const mismatches = []
  const check = (label, sheetVal, incomingVal) => {
    const a = normalize(label, sheetVal)
    const b = normalize(label, incomingVal)
    if (a !== b) mismatches.push({ field: label, sheet: sheetVal, incoming: incomingVal })
  }
  check("truckNo", values[getCol("truckNo") - 1], reqTicket.truckNo)
  check("ticketNumber", values[getCol("ticketNumber") - 1], reqTicket.ticketNumber)
  check("customer", values[getCol("customer") - 1], reqTicket.customerName)
  check("job", values[getCol("job") - 1], reqTicket.jobName)
  check("rate", values[getCol("rate") - 1], reqTicket.rate)
  check("hours", values[getCol("hours") - 1], reqTicket.hours)
  check("amount", values[getCol("amount") - 1], reqTicket.amount)
  return mismatches
}

function rowMatchesTicket(row, reqTicket) {
  return getFieldMismatches(row, reqTicket).length === 0
}

function cleanupDriveFile(invoiceId) {
  const folderId = PropertiesService.getScriptProperties().getProperty('INVOICES_FOLDER')
  if (!folderId) return
  const files = DriveApp.getFolderById(folderId).getFilesByName(`${invoiceId}.pdf`)
  while (files.hasNext()) files.next().setTrashed(true)
}
