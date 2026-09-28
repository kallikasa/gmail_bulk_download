# Gmail Bulk Attachment Downloader

Downloads every attachment from the Gmail conversations you select. Messages containing multiple attachments are downloaded as Gmail ZIP files.

## Install

1. Install a userscript manager such as **Tampermonkey** or **Violentmonkey** in your browser.
2. Open the userscript manager and create a new script.
3. Delete the example code, then copy and paste the complete contents of `gmail-bulk-attachments.user.js`.
4. Save the script and make sure it is enabled.
5. Reload Gmail.

## Use

1. In Gmail, select the conversations whose attachments you want.
2. Click **Download checked** in the panel at the bottom-right.
3. Keep Gmail open until the panel says it has finished.
4. If the browser asks for permission to download multiple files, choose **Allow**.

Files will appear in your browser's normal Downloads folder. Click **Stop** if you need to cancel the current run.

## If it does not work

- Confirm the userscript is enabled, then reload Gmail.
- Close any attachment preview or password window before starting.
- Select at least one conversation before clicking **Download checked**.
