// Google Apps Script that lets the app add a lead to this spreadsheet's
// "Leads" tab. Whoever has EDIT access to the sheet sets it up once:
//
//  1. In the sheet: Extensions > Apps Script. Delete the sample code and paste
//     everything in this file. Save.
//  2. Project Settings (gear icon) > Script properties > Add script property:
//       name  LEAD_TOKEN
//       value a long random password you make up (e.g. 30+ letters/numbers)
//  3. Deploy > New deployment > type "Web app":
//       Execute as: Me      Who has access: Anyone
//     Deploy, approve the permissions it asks for, and copy the "Web app URL".
//  4. In the Supabase dashboard, table app_secrets, put:
//       sheet_webhook_url    -> the Web app URL
//       sheet_webhook_token  -> the same random password as LEAD_TOKEN
//
// The app sends one row per submitted lead, keyed by the exact column names in
// row 1 — columns are matched by NAME, so reordering columns is fine; a column
// the app doesn't send stays blank, and anything the sheet doesn't have is
// ignored. Requests without the right token are refused.

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var token = PropertiesService.getScriptProperties().getProperty('LEAD_TOKEN');
    var body = JSON.parse(e.postData.contents);
    if (!token || body.token !== token) return reply_({ ok: false, error: 'Not authorized.' });

    var sheet = SpreadsheetApp.getActive().getSheetByName('Leads');
    if (!sheet) return reply_({ ok: false, error: 'There is no tab named "Leads".' });

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var data = body.row || {};
    var row = headers.map(function (h) {
      var v = data[String(h).trim()];
      return v === undefined || v === null ? '' : v;
    });

    // "Date Called" arrives as YYYY-MM-DD; store it as a real date.
    var dateCol = headers.indexOf('Date Called');
    if (dateCol >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(row[dateCol]))) {
      var p = String(row[dateCol]).split('-');
      row[dateCol] = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    }

    sheet.appendRow(row);
    return reply_({ ok: true });
  } catch (err) {
    return reply_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
