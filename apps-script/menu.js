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
// VALIDATION
// =====================
function hasMissingRequiredFields(rowValues, generateColIndex) {
  for (let i = 0; i < generateColIndex - 1; i++) {
    if (rowValues[i] === '' || rowValues[i] === null) {
      return true;
    }
  }
  return false;
}

// =====================
// ENTRY POINT
// =====================
function generateForSelectedRow() {
  if (sheet.getName() !== 'Invoice_Spreadsheet') {
    SpreadsheetApp.getUi().alert('Please select a row in the Invoice_Spreadsheet tab.');
    return;
  }
  const row = sheet.getActiveRange().getRow();
  const rowValues = sheet.getRange(row, 1, 1, INVOICE_COL).getValues()[0];
  const invoiceId = sheet.getRange(row, INVOICE_COL).getValue();
  if (!invoiceId) {
    SpreadsheetApp.getUi().alert('Please enter an invoice number in the Invoice # column first.');
    return;
  }
  if (hasMissingRequiredFields(rowValues, INVOICE_COL)) {
    SpreadsheetApp.getUi().alert(
      'Cannot generate invoice: one or more required fields are empty in this row.'
    );
    return;
  }
  generateInvoiceWithConfirmation(sheet, invoiceId);
}

// =====================
// CORE LOGIC
// =====================
function generateInvoiceWithConfirmation(sheet, invoiceId) {
  const data = sheet.getDataRange().getDisplayValues();
  const invoiceColIndex = getCol("invoiceId") - 1;
  const matchingRows = [];
  for (let i = 0; i < data.length; i++) {
    const invoiceCell = data[i][invoiceColIndex];
    if (!invoiceCell) continue;
    if (invoiceCell === invoiceId) {
      matchingRows.push({
        row: i + 1,
        values: data[i]
      });
    }
  }
  if (matchingRows.length === 0) {
    SpreadsheetApp.getUi().alert(`No rows found for Invoice ID: ${invoiceId}`);
    return;
  }

  // =====================
  // CONFIRMATION UI
  // =====================
  const ui = SpreadsheetApp.getUi();
  let summary = `Invoice ID: ${invoiceId}\n\n`;
  matchingRows.forEach(r => {
    summary +=
      `Date: ${r.values[getCol("date") - 1]}\n` +
      `Customer: ${r.values[getCol("customer") - 1]}\n` +
      `Job: ${r.values[getCol("job") - 1]}\n` +
      `Ticket #: ${r.values[getCol("ticketNumber") - 1]}\n` +
      `Hours: ${r.values[getCol("hours") - 1]}\n` +
      `Amount: ${r.values[getCol("amount") - 1]}\n` +
      `---------------------------\n`;
  });
  const response = ui.alert(
    'Confirm Invoice Generation',
    summary,
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) {
    return;
  }

  // =====================
  // GENERATE PDF
  // =====================
  const pdfUrl = sheetsTemplate(matchingRows, invoiceId);

  // =====================
  // WRITE BACK LINK
  // =====================
  matchingRows.forEach(r => {
    const invoiceCell = sheet.getRange(r.row, getCol("invoiceId"));
    const id = invoiceCell.getValue();
    invoiceCell.setFormula(`=HYPERLINK("${pdfUrl}", "${id}")`);
    invoiceCell.setFontColor('#1155CC');
    invoiceCell.setFontLine('underline');
  });
}