// ADX Dashboard Agent - Background Service Worker

// Handle messages from external sources (localhost)
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ status: 'ok', version: '1.0.0' });
    return true;
  }

  // Forward to content script
  chrome.tabs.query({ url: 'https://dataexplorer.azure.com/dashboards/*' }, (tabs) => {
    if (tabs.length === 0) {
      sendResponse({ error: 'No ADX dashboard tab found' });
      return;
    }

    chrome.tabs.sendMessage(tabs[0].id, request, (response) => {
      sendResponse(response);
    });
  });

  return true; // Keep channel open for async response
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'executeInTab') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.url?.includes('dataexplorer.azure.com/dashboards')) {
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: (code) => eval(code),
          args: [request.code]
        }).then(results => {
          sendResponse(results[0]?.result);
        }).catch(err => {
          sendResponse({ error: err.message });
        });
      } else {
        sendResponse({ error: 'Not on an ADX dashboard page' });
      }
    });
    return true;
  }
});
