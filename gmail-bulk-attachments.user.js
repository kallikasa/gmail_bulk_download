// ==UserScript==
// @name         Gmail bulk attachment downloader
// @namespace    local.gmail.bulk.attachments
// @version      4.2.0
// @description  Download every attachment from checked conversations without opening previews.
// @match        https://mail.google.com/mail/u/*
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = '4.2.0';
  const PANEL_ID = 'gmail-bulk-attachment-panel';
  let running = false;
  let stopped = false;
  let requested = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();

  function visible(node) {
    if (!node?.isConnected) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  }

  function status(message) {
    document.getElementById(PANEL_ID + '-status').textContent = message;
    console.info('[Gmail attachments ' + VERSION + '] ' + message);
  }

  function checkStop() {
    if (stopped) throw new Error('Stopped by user.');
  }

  async function waitFor(fn, label, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      checkStop();
      const result = fn();
      if (result) return result;
      await sleep(200);
    }
    throw new Error('Timed out waiting for ' + label + '. Left the page open for inspection.');
  }

  async function waitForOptional(fn, timeout = 4000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      checkStop();
      const result = fn();
      if (result) return result;
      await sleep(200);
    }
    return null;
  }

  function mainRegions() {
    return [...document.querySelectorAll('[role="main"]')].filter(visible);
  }

  function rows() {
    return mainRegions().flatMap((main) => [...main.querySelectorAll('tr')])
      .filter((row) => visible(row) && row.querySelector('[role="checkbox"]'));
  }

  function rowHasAttachment(row) {
    const labeled = [row, ...row.querySelectorAll('[aria-label], [data-tooltip], [title], [alt]')];
    return labeled.some((node) => ['aria-label', 'data-tooltip', 'title', 'alt']
      .some((attr) => /(?:^|\b)has attachment(?:s)?(?:\b|$)/i.test(node.getAttribute?.(attr) || '')));
  }

  function rowInfo(row) {
    const selector = '[data-legacy-last-message-id], [data-legacy-thread-id], [data-thread-id]';
    const node = row.matches(selector) ? row : row.querySelector(selector);
    const routeId = node?.getAttribute('data-legacy-last-message-id')
      || node?.getAttribute('data-legacy-thread-id');
    const identity = node?.getAttribute('data-thread-id')
      || node?.getAttribute('data-legacy-thread-id')
      || routeId;
    const subject = normalize(row.querySelector('.bog')?.textContent) || 'conversation';
    return routeId && identity ? {
      identity,
      routeId,
      subject,
      hasAttachment: rowHasAttachment(row),
    } : null;
  }

  function messages() {
    return mainRegions().flatMap((main) => [...main.querySelectorAll('.adn')]).filter(visible);
  }

  function hasPreview() {
    return [...document.querySelectorAll('input[type="password"], [role="dialog"]')]
      .some((el) => visible(el) && (el.matches('input[type="password"]') || /enter password/i.test(el.textContent)));
  }

  function attachmentCards(root = document) {
    // Message-view containers only; never search-result attachment chips.
    return [...root.querySelectorAll('.aQH .aZo, .aQH [download_url]')]
      .filter((card, index, all) => visible(card) && !all.some((other, j) => j !== index && other.contains(card)));
  }

  function controlLabel(node) {
    return ['aria-label', 'data-tooltip', 'title']
      .map((attr) => normalize(node.getAttribute(attr)))
      .find(Boolean) || normalize(node.textContent);
  }

  function downloadAllControl(message) {
    return [...message.querySelectorAll('button, [role="button"], [aria-label], [data-tooltip], [title]')]
      .find((node) => {
        if (!visible(node) || node.getAttribute('aria-disabled') === 'true' || node.disabled) return false;
        return /^Download all attachments(?:\s|$)/i.test(controlLabel(node));
      }) || null;
  }

  function downloadAllControls() {
    return messages().map(downloadAllControl).filter(Boolean);
  }

  function filename(card) {
    const label = card.querySelector('.aV3');
    if (label) return normalize(label.textContent);
    const raw = card.getAttribute('download_url') || '';
    const urlStart = raw.indexOf(':https://');
    if (urlStart > 0) return raw.slice(raw.indexOf(':') + 1, urlStart);
    return 'attachment';
  }

  function downloadControl(card) {
    // Hidden-on-hover controls are allowed, but only inside this attachment.
    // A preview link or the card itself is NEVER a click target.
    return [...card.querySelectorAll('[role="button"], button, [aria-label], [data-tooltip], [title]')]
      .find((node) => {
        if (node.getAttribute('aria-disabled') === 'true' || node.disabled) return false;
        const labels = ['aria-label', 'data-tooltip', 'title'].map((attr) => normalize(node.getAttribute(attr)));
        if (node.matches('button, [role="button"]')) labels.push(normalize(node.textContent));
        return labels.some((label) => /^Download(?:\s|$)/i.test(label) && !/^Download all\b/i.test(label));
      }) || null;
  }

  function attachmentUrl(card) {
    // Explicit URLs only, and confined to the current attachment.
    for (const node of [card, ...card.querySelectorAll('[download_url], [data-download-url], a[href]')]) {
      for (const attr of ['download_url', 'data-download-url', 'href']) {
        const raw = node.getAttribute(attr);
        if (!raw) continue;
        // Gmail currently prefixes download_url with MIME type and filename, and
        // sometimes includes an obsolete Gmail URL before the real one.
        const embedded = raw.lastIndexOf('https://');
        const candidate = embedded >= 0 ? raw.slice(embedded) : raw;
        try {
          const url = new URL(candidate, location.href);
          if (url.protocol !== 'https:' || url.username || url.password) continue;
          const gmailAttachment = url.hostname === 'mail.google.com' && url.searchParams.get('view') === 'att'
            && url.searchParams.has('attid');
          const hostedAttachment = url.hostname === 'mail-attachment.googleusercontent.com' && attr !== 'href';
          if (!gmailAttachment && !hostedAttachment) continue;
          if (gmailAttachment) url.searchParams.set('disp', 'attd');
          return url.href;
        } catch { /* Not an attachment URL. */ }
      }
    }
    return null;
  }

  function requestDownload(card) {
    // Prefer Gmail's direct attachment endpoint. Its native Download button can
    // route encrypted PDFs into the password preview instead of downloading.
    const url = attachmentUrl(card);
    if (url) {
      const frame = document.createElement('iframe');
      frame.name = 'gmail-attachment-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      frame.hidden = true;
      document.body.appendChild(frame);
      const link = document.createElement('a');
      link.href = url;
      link.target = frame.name;
      link.download = filename(card);
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => frame.remove(), 120000);
      return 'attachment URL';
    }
    const control = downloadControl(card);
    if (control) {
      control.click();
      return 'native Download button fallback';
    }
    throw new Error('No Download control or attachment URL for “' + filename(card) +
      '”. Nothing clicked. Leave this email open and report this message.');
  }

  async function prepareMessage() {
    await waitFor(() => messages().length, 'the email message');
    const expand = mainRegions().flatMap((main) => [...main.querySelectorAll('[aria-label], [data-tooltip]')])
      .find((node) => visible(node) && ['aria-label', 'data-tooltip'].some((attr) =>
        /^Expand all(?:\s|$)/i.test(node.getAttribute(attr) || '')));
    if (expand) expand.click();
    await waitFor(() => attachmentCards().length || downloadAllControls().length,
      'message attachment controls');
    let lastSignature = '';
    let stableSince = Date.now();
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      checkStop();
      const signature = [messages().length, attachmentCards().length, downloadAllControls().length].join(':');
      if (signature !== lastSignature) { lastSignature = signature; stableSince = Date.now(); }
      if (Date.now() - stableSince >= 1500) return;
      await sleep(200);
    }
    throw new Error('Attachment list is still changing. Retry after the email finishes loading.');
  }

  async function downloadMessage(prefix) {
    await prepareMessage();
    const jobs = messages().map((message) => ({
      all: downloadAllControl(message),
      cards: attachmentCards(message),
    })).filter((job) => job.all || job.cards.length);
    if (!jobs.length) throw new Error('No downloadable attachments were found in this conversation.');

    let attachmentNumber = 0;
    const individualTotal = jobs.filter((job) => !job.all)
      .reduce((total, job) => total + job.cards.length, 0);
    for (let messageIndex = 0; messageIndex < jobs.length; messageIndex += 1) {
      checkStop();
      if (hasPreview()) throw new Error('A password preview is open. Close it and reload Gmail before retrying.');
      const job = jobs[messageIndex];
      if (job.all) {
        job.all.click();
        await sleep(1600);
        if (hasPreview()) throw new Error('Gmail opened a preview instead of downloading all attachments.');
        requested += 1;
        status(prefix + ': requested Gmail ZIP ' + (messageIndex + 1) + '/' + jobs.length
          + ' containing all attachments in this message.');
        continue;
      }
      for (const card of job.cards) {
        checkStop();
        if (!visible(card)) throw new Error('The attachment list changed. Stopped without selecting a different file.');
        const name = filename(card);
        const method = requestDownload(card);
        await sleep(1200);
        if (hasPreview()) throw new Error('Gmail opened a preview for “' + name + '”. Download unconfirmed; stopped on this email.');
        requested += 1;
        attachmentNumber += 1;
        status(prefix + ': requested file ' + attachmentNumber + '/' + individualTotal
          + ' — ' + name + ' (' + method + ').');
      }
    }
  }

  function conversationHash(listHash, routeId) {
    return listHash.replace(/\/+$/, '') + '/' + encodeURIComponent(routeId);
  }

  async function openConversation(item, listHash) {
    const matches = rows().filter((row) => rowInfo(row)?.identity === item.identity);
    if (matches.length !== 1) {
      throw new Error('Could not uniquely find “' + item.subject + '” in the current message list.');
    }

    // Gmail's current UI exposes the conversation target as a div[role=link].
    // Clicking the old .bog subject span no longer opens the conversation.
    const opener = matches[0].querySelector('.xS[role="link"], td.a4W [role="link"], [role="link"]')
      || matches[0].querySelector('td.a4W');
    if (opener) {
      opener.click();
      if (await waitForOptional(() => messages().length, 5000)) return;
    }

    // Fallback for Gmail variants where the link is not exposed to the userscript.
    location.hash = conversationHash(listHash, item.routeId);
    await waitFor(() => location.hash !== listHash && messages().length, 'the selected email to open');
  }

  async function run() {
    if (running) return;
    running = true;
    stopped = false;
    requested = 0;
    const panel = document.getElementById(PANEL_ID);
    panel.querySelectorAll('button[data-start]').forEach((button) => { button.disabled = true; });
    const stop = panel.querySelector('[data-stop]');
    stop.hidden = false;
    try {
      if (hasPreview()) throw new Error('Close the password preview and reload Gmail before starting v4.2.');
      const selected = rows().filter((row) => row.querySelector('[role="checkbox"][aria-checked="true"]'));
      if (!selected.length) throw new Error('Check conversations in the message list first.');
      const selectedItems = selected.map(rowInfo);
      if (selectedItems.some((item) => !item)) {
        throw new Error('Gmail did not expose an ID for one selected conversation. Reload Gmail and retry.');
      }
      if (new Set(selectedItems.map((item) => item.identity)).size !== selectedItems.length) {
        throw new Error('Gmail reported duplicate IDs for selected conversations. Reload Gmail and retry.');
      }
      const skipped = selectedItems.filter((item) => !item.hasAttachment).length;
      const queue = selectedItems.filter((item) => item.hasAttachment);
      if (!queue.length) {
        status('Finished: none of the selected conversations has an attachment. Skipped '
          + skipped + ' conversation(s).');
        return;
      }
      const resultsHash = location.hash;
      for (let i = 0; i < queue.length; i += 1) {
        checkStop();
        status('Opening email ' + (i + 1) + '/' + queue.length + ' — ' + queue[i].subject + '…');
        await openConversation(queue[i], resultsHash);
        await downloadMessage('Email ' + (i + 1) + '/' + queue.length);
        location.hash = resultsHash;
        await waitFor(() => location.hash === resultsHash && rows().length, 'the message list');
        await sleep(400);
      }
      status('Finished: ' + requested + ' download request(s); skipped ' + skipped
        + ' selected conversation(s) without attachments. Gmail uses ZIP files when a message has multiple attachments. Check browser Downloads; this script cannot confirm disk saves.');
    } catch (error) {
      status(error.message + ' ' + requested + ' earlier download request(s).');
    } finally {
      running = false;
      stop.hidden = true;
      panel.querySelectorAll('button[data-start]').forEach((button) => { button.disabled = false; });
    }
  }

  function mount() {
    if (!document.body || document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:310px;padding:14px;border-radius:12px;background:white;color:#202124;box-shadow:0 3px 16px #0005;font:13px/1.4 Arial,sans-serif';
    const title = document.createElement('strong');
    title.textContent = 'Gmail attachment downloader v' + VERSION;
    panel.append(title);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.start = '';
    button.textContent = 'Download checked';
    button.style.cssText = 'display:block;margin-top:9px;padding:8px 12px;border:0;border-radius:16px;background:#0b57d0;color:white;cursor:pointer';
    button.addEventListener('click', run);
    panel.append(button);
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.dataset.stop = '';
    stop.textContent = 'Stop';
    stop.hidden = true;
    stop.addEventListener('click', () => { stopped = true; });
    const note = document.createElement('div');
    note.id = PANEL_ID + '-status';
    note.style.cssText = 'margin-top:10px;color:#5f6368';
    note.textContent = 'Downloads everything. Messages with multiple attachments are saved as Gmail ZIP files. Your browser may ask to allow multiple downloads.';
    panel.append(stop, note);
    document.body.append(panel);
  }

  mount();
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
})();
