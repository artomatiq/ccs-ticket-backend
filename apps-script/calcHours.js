// =====================
// CALC HOURS + AMOUNT
// =====================
// Mirrors the quarter-hour rounding in the dt-ticket-db-confirm Lambda:
//   hours  = round((stop - start) in hours * 4) / 4
//   amount = hours * rate
// If that rounding rule or the rate ever changes, update both places.
//
// Runs only when invoked (menu item or assigned button) on the selected
// row(s) of Invoice_Spreadsheet. Writes the hours and amount columns.
function calcHoursForSelectedRows() {
  const ui = SpreadsheetApp.getUi();
  const activeSheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (activeSheet.getName() !== 'Invoice_Spreadsheet') {
    ui.alert('Please select a row in the Invoice_Spreadsheet tab.');
    return;
  }

  const sel = activeSheet.getActiveRange();
  if (sel.getRow() < 2) {
    ui.alert('Please select a data row.');
    return;
  }

  const startCol = getCol('start');
  const stopCol = getCol('stop');
  const hoursCol = getCol('hours');
  const amountCol = getCol('amount');

  // Pass 1: compute what we'd write, without touching the sheet.
  const updates = [];
  const skipped = [];
  for (let i = 0; i < sel.getNumRows(); i++) {
    const row = sel.getRow() + i;
    const start = activeSheet.getRange(row, startCol).getValue();
    const stop = activeSheet.getRange(row, stopCol).getValue();

    if (!(start instanceof Date) || !(stop instanceof Date)) {
      skipped.push(`Row ${row}: start/stop is not a time value`);
      continue;
    }
    if (stop <= start) {
      skipped.push(`Row ${row}: stop is not after start`);
      continue;
    }

    // 36e5 = milliseconds per hour
    const hours = Math.round(((stop - start) / 36e5) * 4) / 4;
    const amount = hours * rateConstant;
    updates.push({ row, hours, amount });
  }

  if (updates.length === 0) {
    ui.alert(`Nothing to calculate.\n${skipped.join('\n')}`);
    return;
  }

  // Confirm before writing.
  let summary = `Calculate hours + amount for ${updates.length} row(s)?\n\n`;
  for (const u of updates) {
    summary += `Row ${u.row}:  ${u.hours} hrs  =  $${u.amount.toFixed(2)}\n`;
  }
  if (skipped.length > 0) {
    summary += `\nSkipped:\n${skipped.join('\n')}`;
  }
  const response = ui.alert('Confirm Calculation', summary, ui.ButtonSet.YES_NO);
  if (response !== ui.Button.YES) return;

  // Pass 2: write.
  for (const u of updates) {
    activeSheet.getRange(u.row, hoursCol).setValue(u.hours);
    activeSheet.getRange(u.row, amountCol).setValue(u.amount);
  }
  SpreadsheetApp.flush();
}
