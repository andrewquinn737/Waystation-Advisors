// Google Apps Script that lets the app add — or UPDATE — a lead on this spreadsheet's "Leads" tab.
// Whoever has EDIT access to the sheet sets it up once:
//  1. In the sheet: Extensions > Apps Script. Delete the sample code and paste everything in this file. Save.
//  2. Project Settings (gear icon) > Script properties: LEAD_TOKEN = a long random password you make up.
//  3. Deploy > Manage deployments > pencil icon > Version: New version > Deploy (or New deployment > Web app,
//     Execute as: Me, Who has access: Anyone) — copy the Web app URL.
//  4. In the Supabase dashboard, table app_secrets: sheet_webhook_url = that URL, sheet_webhook_token = the
//     same password as LEAD_TOKEN.
//
// Every submission is an upsert: the row whose "Company Name" matches (ignoring case and punctuation) is
// UPDATED — only cells whose value changed, never "Date Called" — and a new row is added only when no row
// matches. Columns are matched by the names in row 1; a column the app doesn't send stays as it is.

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
    var nameCol = headers.indexOf('Company Name');
    var wanted = norm_(body.match || data['Company Name']);

    // 1) existing row for this company? (newest match wins)
    var rowIdx = -1;
    var last = sheet.getLastRow();
    if (wanted && nameCol >= 0 && last >= 2) {
      var names = sheet.getRange(2, nameCol + 1, last - 1, 1).getValues();
      for (var i = names.length - 1; i >= 0; i--) {
        if (norm_(names[i][0]) === wanted) { rowIdx = i + 2; break; }
      }
    }

    if (rowIdx > 0) {
      var current = sheet.getRange(rowIdx, 1, 1, headers.length).getValues()[0];
      var changed = 0;
      headers.forEach(function (h, c) {
        var key = String(h).trim();
        if (key === 'Date Called') return;
        var v = data[key];
        if (v === undefined || v === null || String(v) === '') return;
        if (String(current[c]).trim() === String(v).trim()) return;
        sheet.getRange(rowIdx, c + 1).setValue(v);
        changed++;
      });
      return reply_({ ok: true, action: 'updated', row: rowIdx, changed: changed });
    }

    // 2) none found: add a new row ("Date Called" arrives as a date string and is read as a plain date)
    var row = headers.map(function (h) {
      var v = data[String(h).trim()];
      return v === undefined || v === null ? '' : v;
    });
    sheet.appendRow(row);
    return reply_({ ok: true, action: 'added' });
  } catch (err) {
    return reply_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function norm_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
