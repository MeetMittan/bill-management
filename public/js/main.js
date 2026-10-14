/**
 * Audit & Tax Bill Management Application
 * Core Client-side Vanilla JavaScript (DOM & Fetch API)
 */

document.addEventListener('DOMContentLoaded', () => {
  initToasts();
  initPiiToggles();
  initStatusToggles();
  initUploadForm();
  initSettingsForm();
});

// Toast Notification Manager
function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  toast.innerHTML = `
    <span>${icon}</span>
    <div style="flex: 1; font-size: 0.9rem;">${message}</div>
    <button style="background: none; border: none; cursor: pointer; color: #94a3b8; font-size: 1rem;" onclick="this.parentElement.remove()">&times;</button>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}

function initToasts() {
  window.showToast = showToast;
}

// Interactive Payment Status Toggle
function initStatusToggles() {
  document.querySelectorAll('.btn-status-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const billId = btn.dataset.billId;
      if (!billId) return;

      btn.disabled = true;
      const originalText = btn.innerHTML;
      btn.innerHTML = 'Updating...';

      try {
        const response = await fetch(`/api/bills/${billId}/toggle-status`, {
          method: 'PATCH',
          headers: { 'Accept': 'application/json' }
        });
        const result = await response.json();

        if (result.success) {
          showToast(result.message, 'success');
          // Update status badge dynamically
          const badge = document.getElementById(`status-badge-${billId}`);
          if (badge) {
            badge.className = `badge badge-${result.newStatus.toLowerCase()}`;
            badge.textContent = result.newStatus;
          }
          btn.innerHTML = result.newStatus === 'Paid' ? 'Mark Due' : 'Mark Paid';
        } else {
          showToast(result.message || 'Failed to update status', 'error');
          btn.innerHTML = originalText;
        }
      } catch (err) {
        showToast('Network error while toggling status', 'error');
        btn.innerHTML = originalText;
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// PII Masking Toggle (Visual & Persistent)
function initPiiToggles() {
  document.querySelectorAll('.pii-mask-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetSelector = btn.dataset.target || '.pii-target';
      const billId = btn.dataset.billId;
      const elements = document.querySelectorAll(targetSelector);

      let currentlyMasked = false;
      elements.forEach(el => {
        if (el.classList.contains('pii-masked')) {
          currentlyMasked = true;
          el.classList.remove('pii-masked');
        } else {
          el.classList.add('pii-masked');
        }
      });

      const isNowMasked = !currentlyMasked;
      btn.innerHTML = isNowMasked ? '👁️ Reveal PII' : '🔒 Mask Sensitive PII';
      showToast(isNowMasked ? 'Sensitive PII masked for privacy.' : 'Sensitive PII revealed.', 'info');

      // Persist to server if billId is attached
      if (billId) {
        try {
          await fetch(`/api/bills/${billId}/toggle-pii`, {
            method: 'PATCH',
            headers: { 'Accept': 'application/json' }
          });
        } catch (e) {
          console.warn('Could not persist PII state');
        }
      }
    });
  });
}

// Bill File Upload & Live Pipeline Progress UI
function initUploadForm() {
  const uploadForm = document.getElementById('bill-upload-form');
  const dropzone = document.getElementById('upload-dropzone');
  const fileInput = document.getElementById('billFile');
  const progressBox = document.getElementById('upload-progress-box');
  const progressBar = document.getElementById('upload-progress-bar');
  const statusLabel = document.getElementById('upload-status-label');

  if (!uploadForm || !fileInput) return;

  if (dropzone) {
    dropzone.addEventListener('click', () => fileInput.click());
    
    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        fileInput.files = e.dataTransfer.files;
        handleFileSelect(fileInput.files[0]);
      }
    });
  }

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      handleFileSelect(fileInput.files[0]);
    }
  });

  function handleFileSelect(file) {
    const fileNameDisplay = document.getElementById('selected-file-name');
    if (fileNameDisplay) {
      const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
      fileNameDisplay.textContent = `Selected: ${file.name} (${sizeMb} MB)`;
    }
  }

  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!fileInput.files || fileInput.files.length === 0) {
      showToast('Please select a bill or invoice file first.', 'error');
      return;
    }

    const file = fileInput.files[0];
    if (file.size > 10 * 1024 * 1024) {
      showToast('File size exceeds the 10MB limit. Please upload a smaller file.', 'error');
      return;
    }

    const formData = new FormData(uploadForm);
    const submitBtn = uploadForm.querySelector('button[type="submit"]');

    if (submitBtn) submitBtn.disabled = true;
    if (progressBox) progressBox.style.display = 'block';
    if (progressBar) progressBar.style.width = '25%';
    if (statusLabel) statusLabel.textContent = 'Step 1/3: Uploading encrypted file to server...';

    try {
      setTimeout(() => {
        if (progressBar) progressBar.style.width = '60%';
        if (statusLabel) statusLabel.textContent = 'Step 2/3: OCR extracting textual data (Tesseract / PDF)...';
      }, 1500);

      setTimeout(() => {
        if (progressBar) progressBar.style.width = '85%';
        if (statusLabel) statusLabel.textContent = 'Step 3/3: AI structuring fields and running audit math checks...';
      }, 3500);

      const response = await fetch('/api/bills/upload', {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      if (response.ok && result.success) {
        if (progressBar) progressBar.style.width = '100%';
        if (statusLabel) statusLabel.textContent = 'Analysis complete! Redirecting to review...';
        showToast('Bill successfully analyzed & audited!', 'success');
        setTimeout(() => {
          window.location.href = `/bills/${result.billId}`;
        }, 800);
      } else {
        if (progressBox) progressBox.style.display = 'none';
        showToast(result.message || 'Error processing invoice', 'error');
        if (submitBtn) submitBtn.disabled = false;
      }
    } catch (err) {
      if (progressBox) progressBox.style.display = 'none';
      showToast(`Network or server error: ${err.message}`, 'error');
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// Settings Form & AI Key Connectivity Testing
function initSettingsForm() {
  const testAiBtn = document.getElementById('btn-test-ai');
  if (testAiBtn) {
    testAiBtn.addEventListener('click', async () => {
      const provider = document.getElementById('preferredProvider')?.value || 'ollama';
      const baseUrl = document.getElementById('ollamaBaseUrl')?.value;
      const model = document.getElementById('ollamaModel')?.value;
      const geminiApiKey = document.getElementById('geminiApiKey')?.value;
      const openAiApiKey = document.getElementById('openAiApiKey')?.value;

      testAiBtn.disabled = true;
      testAiBtn.innerHTML = 'Testing connection...';

      try {
        const apiKey = provider === 'gemini' ? geminiApiKey : openAiApiKey;
        const res = await fetch('/api/settings/test-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, baseUrl, model, apiKey })
        });
        const result = await res.json();

        if (result.success) {
          showToast(`✅ ${result.message} (${result.latencyMs}ms)`, 'success');
        } else {
          showToast(`❌ ${result.message}`, 'error');
        }
      } catch (err) {
        showToast(`Connection failed: ${err.message}`, 'error');
      } finally {
        testAiBtn.disabled = false;
        testAiBtn.innerHTML = '⚡ Test Connection';
      }
    });
  }

  const settingsForm = document.getElementById('settings-form');
  if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(settingsForm);
      const data = Object.fromEntries(formData.entries());

      try {
        const res = await fetch('/api/settings/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const result = await res.json();
        if (result.success) {
          showToast(result.message, 'success');
        } else {
          showToast(result.message || 'Failed to update settings', 'error');
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      }
    });
  }
}

// Global Delete Bill confirmation helper
window.deleteBill = async function(billId) {
  if (!confirm('Are you sure you want to permanently delete this bill record and its uploaded invoice?')) {
    return;
  }

  try {
    const res = await fetch(`/api/bills/${billId}`, {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' }
    });
    const result = await res.json();
    if (result.success) {
      showToast('Bill deleted successfully', 'success');
      setTimeout(() => {
        window.location.href = '/bills';
      }, 500);
    } else {
      showToast(result.message || 'Failed to delete bill', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
};

