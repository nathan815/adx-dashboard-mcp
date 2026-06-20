// ADX Dashboard Agent - Popup Script

let currentDashboard = null;

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const outputEl = document.getElementById('output');
  const getDashboardBtn = document.getElementById('getDashboard');
  const copyJsonBtn = document.getElementById('copyJson');

  // Check if on ADX dashboard page
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab?.url?.includes('dataexplorer.azure.com/dashboards')) {
      statusEl.textContent = '✓ Connected to ADX Dashboard';
      statusEl.className = 'status connected';
      getDashboardBtn.disabled = false;
    } else {
      statusEl.textContent = '✗ Not on an ADX dashboard page';
      statusEl.className = 'status disconnected';
      getDashboardBtn.disabled = true;
    }
  });

  // Get Dashboard button
  getDashboardBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          if (window.__adxAgent) {
            return window.__adxAgent.getDashboard();
          }
          return { error: 'ADX Agent not loaded' };
        }
      }).then(results => {
        const result = results[0]?.result;
        if (result?.error) {
          outputEl.textContent = 'Error: ' + result.error;
        } else {
          currentDashboard = result;
          outputEl.textContent = JSON.stringify(result, null, 2).slice(0, 2000) + '...';
          copyJsonBtn.disabled = false;
        }
        outputEl.style.display = 'block';
      }).catch(err => {
        outputEl.textContent = 'Error: ' + err.message;
        outputEl.style.display = 'block';
      });
    });
  });

  // Copy JSON button
  copyJsonBtn.addEventListener('click', () => {
    if (currentDashboard) {
      navigator.clipboard.writeText(JSON.stringify(currentDashboard, null, 2))
        .then(() => {
          copyJsonBtn.textContent = 'Copied!';
          setTimeout(() => { copyJsonBtn.textContent = 'Copy to Clipboard'; }, 2000);
        });
    }
  });
});
