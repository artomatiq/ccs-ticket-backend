// =====================
// TEMPLATE + PDF
// =====================
function sheetsTemplate(rows, invoiceId) {
  const normalizedRows = rows.map(r => {
    if (typeof r === "number") {
      return {
        row: r,
        values: invoiceSheet.getRange(r, 1, 1, getCol("truckNo")).getDisplayValues()[0]
      }
    }
    return r
  })
  // HEADER
  templateSheet.getRange('I3:K3').setValue(invoiceId)
  const firstRow = normalizedRows[0].row
  const rawDate = invoiceSheet.getRange(firstRow, getCol("date")).getValue()
  let dateObj = rawDate instanceof Date ? rawDate : new Date(rawDate)
  if (isNaN(dateObj.getTime())) {
    throw new Error(`Invalid date in row ${firstRow}. Cell may be empty.`)
  }
  const formattedDate = Utilities.formatDate(
    dateObj,
    Session.getScriptTimeZone(),
    "dd MMM, yyyy"
  )
  templateSheet.getRange('I4:K4').setValue(formattedDate)

  // CLEAR OLD ROWS
  templateSheet.getRange('B12:J17').clearContent()

  // LINE ITEMS
  normalizedRows.forEach((r, index) => {
    const rowNum = 12 + index
    const rate = parseFloat(r.values[getCol("rate") - 1].replace(/[$,]/g, "")) || 0
    const amount = parseFloat(r.values[getCol("amount") - 1].replace(/[$,]/g, "")) || 0
    templateSheet.getRange(`B${rowNum}`).setValue(r.values[getCol("date") - 1])
    templateSheet.getRange(`C${rowNum}`).setValue(r.values[getCol("truckNo") - 1])
    templateSheet.getRange(`D${rowNum}`).setValue(r.values[getCol("ticketNumber") - 1])
    templateSheet.getRange(`E${rowNum}`).setValue(r.values[getCol("customer") - 1])
    templateSheet.getRange(`F${rowNum}`).setValue(r.values[getCol("job") - 1])
    templateSheet.getRange(`G${rowNum}:H${rowNum}`).setValue(rate)
    templateSheet.getRange(`I${rowNum}`).setValue(r.values[getCol("hours") - 1])
    templateSheet.getRange(`J${rowNum}`).setValue(r.values[getCol("amount") - 1])
  })
  SpreadsheetApp.flush()

  // EXPORT PDF
  const url =
    `https://docs.google.com/spreadsheets/d/${ss.getId()}/export?` +
    `format=pdf&portrait=true&size=letter&fitw=true&` +
    `top_margin=0.9&bottom_margin=0&left_margin=1.0&right_margin=0&` +
    `sheetnames=false&printtitle=false&pagenumbers=false&gridlines=false&fzr=false&` +
    `gid=${templateSheet.getSheetId()}`
  const token = ScriptApp.getOAuthToken()
  const response = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token }
  })
  const invoiceFolderId = PropertiesService.getScriptProperties().getProperty('INVOICES_FOLDER')
  if (!invoiceFolderId) throw new Error('Missing INVOICES_FOLDER script property')
  const pdfName = `${invoiceId}.pdf`
  const file = DriveApp.getFolderById(invoiceFolderId).createFile(response.getBlob()).setName(pdfName)
  return file.getUrl()
}