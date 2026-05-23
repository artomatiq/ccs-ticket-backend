// =====================
// MENU
// =====================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Invoices')
    .addItem('Generate Invoice for Selected Row', 'generateForSelectedRow')
    .addToUi();
}

// =====================
// ENTRY POINT
// =====================
function generateForSelectedRow() {
  const ui = SpreadsheetApp.getUi();
  const activeSheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (activeSheet.getName() !== 'Invoice_Spreadsheet') {
    ui.alert('Please select a row in the Invoice_Spreadsheet tab.');
    return;
  }

  const selectedRow = activeSheet.getActiveRange().getRow();
  if (selectedRow < 2) {
    ui.alert('Please select a data row.');
    return;
  }

  // 1. Read date from selected row
  const selectedDate = activeSheet.getRange(selectedRow, getCol('date')).getDisplayValue();
  if (!selectedDate) {
    ui.alert('Selected row has no date.');
    return;
  }
  const normalizedDate = normalize('date', selectedDate);

  // 2. Find all rows with that date
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    ui.alert('No data rows in sheet.');
    return;
  }
  const colCount = getCol('truckNo');
  const allData = sheet.getRange(2, 1, lastRow - 1, colCount).getDisplayValues();
  const dateRows = [];
  for (let i = 0; i < allData.length; i++) {
    if (normalize('date', allData[i][getCol('date') - 1]) === normalizedDate) {
      dateRows.push({ row: i + 2, values: allData[i] });
    }
  }
  if (dateRows.length === 0) {
    ui.alert(`No rows found for date: ${selectedDate}`);
    return;
  }

  // 3. Check for duplicate ticket numbers
  const ticketNums = dateRows.map(r => normalize('ticketNumber', r.values[getCol('ticketNumber') - 1]));
  const seen = {};
  const dupes = [];
  for (const tn of ticketNums) {
    if (seen[tn]) dupes.push(tn);
    seen[tn] = true;
  }
  if (dupes.length > 0) {
    ui.alert(`Duplicate ticket numbers for ${selectedDate}: ${[...new Set(dupes)].join(', ')}`);
    return;
  }

  // 4. Verify all required fields are present
  const REQUIRED = ['date', 'customer', 'job', 'ticketNumber', 'start', 'stop', 'hours', 'amount', 'rate', 'truckNo'];
  const missing = [];
  for (const r of dateRows) {
    for (const col of REQUIRED) {
      if (!r.values[getCol(col) - 1]) {
        missing.push(`Row ${r.row}: missing ${col}`);
      }
    }
  }
  if (missing.length > 0) {
    ui.alert(`Missing required fields:\n${missing.join('\n')}`);
    return;
  }

  // 5. Verify all rows have the same invoice number entered
  const invoiceVals = dateRows.map(r => String(r.values[getCol('invoiceId') - 1]).trim());
  const emptyInvoice = invoiceVals.filter(v => !v);
  if (emptyInvoice.length > 0) {
    ui.alert(`${emptyInvoice.length} row(s) for ${selectedDate} have no invoice number entered.`);
    return;
  }
  const uniqueInvoiceIds = [...new Set(invoiceVals)];
  if (uniqueInvoiceIds.length > 1) {
    ui.alert(`Rows for ${selectedDate} have different invoice numbers: ${uniqueInvoiceIds.join(', ')}`);
    return;
  }
  const invoiceId = uniqueInvoiceIds[0];

  // 6. Verify none of the invoice cells already have a hyperlink
  const alreadyLinked = dateRows.some(r =>
    sheet.getRange(r.row, INVOICE_COL).getFormula().startsWith('=HYPERLINK')
  );
  if (alreadyLinked) {
    ui.alert(`Invoice ${invoiceId} already has a generated PDF. Remove the existing hyperlink(s) first.`);
    return;
  }

  // 7. Confirmation dialog
  const totalHours = dateRows.reduce((sum, r) => sum + (parseFloat(r.values[getCol('hours') - 1]) || 0), 0);
  const totalAmount = dateRows.reduce((sum, r) => sum + (parseFloat(String(r.values[getCol('amount') - 1]).replace(/[$,]/g, '')) || 0), 0);
  let summary = `Invoice: ${invoiceId}\nDate: ${selectedDate}\nTotal Hours: ${totalHours}\nTotal Amount: $${totalAmount.toFixed(2)}\n\n`;
  for (const r of dateRows) {
    summary +=
      `Ticket #${r.values[getCol('ticketNumber') - 1]}  ${r.values[getCol('customer') - 1]} / ${r.values[getCol('job') - 1]}\n`;
  }
  const response = ui.alert('Confirm Invoice Generation', summary, ui.ButtonSet.YES_NO);
  if (response !== ui.Button.YES) return;

  // 8. Generate PDF
  const rowNums = dateRows.map(r => r.row);
  const pdfUrl = sheetsTemplate(rowNums, invoiceId);

  // 9. Replace invoice ID text with hyperlink formula
  for (const r of dateRows) {
    const cell = sheet.getRange(r.row, INVOICE_COL);
    cell.setFormula(`=HYPERLINK("${pdfUrl}", "${invoiceId}")`);
    cell.setFontColor('#1155CC');
    cell.setFontLine('underline');
  }
  SpreadsheetApp.flush();
  ui.alert(`Invoice ${invoiceId} generated successfully.`);
}
