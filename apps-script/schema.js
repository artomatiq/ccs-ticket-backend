const rateConstant = 105

const SCHEMA = {
  date: "A",
  customer: "B",
  job: "C",
  ticketNumber: "D",
  start: "E",
  stop: "F",
  hours: "G",
  amount: "H",
  invoiceId: "I",
  paid: "J",
  rate: "K",
  truckNo: "L",
  notes: "M",
  flags: "N",
};

function getCol(key) {
  const letter = SCHEMA[key];
  if (!letter) {
    throw new Error(`Invalid column key: ${key}`);
  }
  return letter.charCodeAt(0) - 64;
}

const sheet = SpreadsheetApp
  .getActiveSpreadsheet()
  .getSheetByName('Invoice_Spreadsheet');

if (!sheet) {
  throw new Error('Sheet not found: Invoice_Spreadsheet');
}
const ss = SpreadsheetApp.getActiveSpreadsheet();
const invoiceSheet = ss.getSheetByName('Invoice_Spreadsheet')
const INVOICE_COL = getCol('invoiceId')
const templateSheet = ss.getSheetByName('Invoice_Template')