/**
 * Audit & Tax Bill Management Application
 * Core Client-side Vanilla JavaScript (DOM & Fetch API)
 */

document.addEventListener('DOMContentLoaded', () => {
  initResponsiveNav();
  initToasts();
  initPiiToggles();
  initStatusToggles();
  initUploadForm();
  initSettingsForm();
  initProfileForms();
});

// Responsive Navbar & Mobile Menu Manager
function initResponsiveNav() {
  const toggleBtn = document.getElementById('navToggle');
  const navMenu = document.getElementById('navMenu');

  if (toggleBtn && navMenu) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = navMenu.classList.toggle('open');
      toggleBtn.classList.toggle('open', isOpen);
    });

    // Close mobile menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!navMenu.contains(e.target) && !toggleBtn.contains(e.target)) {
        navMenu.classList.remove('open');
        toggleBtn.classList.remove('open');
      }
    });

    // Close mobile menu when clicking any nav link
    navMenu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        navMenu.classList.remove('open');
        toggleBtn.classList.remove('open');
      });
    });
  }

  // Active Navigation Link Highlighting
  const currentPath = window.location.pathname;
  document.querySelectorAll('.nav-links a').forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPath || (href !== '/' && currentPath.startsWith(href) && href !== '/bills' && currentPath === href) || (href === '/bills' && currentPath.startsWith('/bills'))) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });
}

// Toast Notification Manager (Clean, non-cluttered)
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
  
  toast.innerHTML = `
    <div style="flex: 1; font-size: 0.875rem; color: var(--text-main);">${message}</div>
    <button type="button" style="background: none; border: none; cursor: pointer; color: var(--text-muted); font-size: 1.1rem; line-height: 1;" onclick="this.parentElement.remove()">&times;</button>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
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
        showToast('Unable to update payment status. Please try again.', 'error');
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
      btn.innerHTML = isNowMasked ? 'Reveal Data' : 'Mask Sensitive Data';
      showToast(isNowMasked ? 'Sensitive fields masked.' : 'Sensitive fields revealed.', 'info');

      // Persist to server if billId is attached
      if (billId) {
        try {
          await fetch(`/api/bills/${billId}/toggle-pii`, {
            method: 'PATCH',
            headers: { 'Accept': 'application/json' }
          });
        } catch (e) {
          // Silent fallback
        }
      }
    });
  });
}

// Bill File Upload & Clean Progress UI
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
      showToast('Please select an invoice file to upload.', 'error');
      return;
    }

    const file = fileInput.files[0];
    if (file.size > 10 * 1024 * 1024) {
      showToast('File size exceeds the 10MB limit. Please upload a smaller file.', 'error');
      return;
    }

    const formData = new FormData(uploadForm);
    const submitBtn = uploadForm.querySelector('button[type="submit"]');

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Uploading...';
    }
    if (progressBox) progressBox.style.display = 'block';
    if (progressBar) progressBar.style.width = '25%';
    if (statusLabel) statusLabel.textContent = 'Step 1 of 3: Uploading invoice...';

    try {
      setTimeout(() => {
        if (progressBar) progressBar.style.width = '60%';
        if (statusLabel) statusLabel.textContent = 'Step 2 of 3: Extracting text from document...';
      }, 1200);

      setTimeout(() => {
        if (progressBar) progressBar.style.width = '85%';
        if (statusLabel) statusLabel.textContent = 'Step 3 of 3: Verifying amounts and categories...';
      }, 2800);

      const response = await fetch('/api/bills/upload', {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      if (response.ok && result.success) {
        if (progressBar) progressBar.style.width = '100%';
        if (statusLabel) statusLabel.textContent = 'Complete! Loading bill details...';
        showToast('Bill successfully processed and verified.', 'success');
        setTimeout(() => {
          window.location.href = `/bills/${result.billId}`;
        }, 700);
      } else {
        if (progressBox) progressBox.style.display = 'none';
        showToast(result.message || 'Could not process the invoice. Please ensure the amounts match.', 'error');
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Upload & Verify Bill';
        }
      }
    } catch (err) {
      if (progressBox) progressBox.style.display = 'none';
      showToast('A network error occurred while uploading. Please try again.', 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Upload & Verify Bill';
      }
    }
  });
}

// Clean Settings Form handler (Targeting /api/settings/profile)
function initSettingsForm() {
  const settingsForm = document.getElementById('settings-form');
  if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const saveBtn = document.getElementById('btn-save-settings');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
      }

      const nameInput = document.getElementById('userName');
      const emailAlertsCheckbox = document.getElementById('emailAlertsEnabled');

      const payload = {
        name: nameInput ? nameInput.value.trim() : '',
        emailAlertsEnabled: emailAlertsCheckbox ? emailAlertsCheckbox.checked : false
      };

      try {
        const res = await fetch('/api/settings/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (result.success) {
          showToast(result.message || 'Profile updated successfully.', 'success');
          setTimeout(() => window.location.reload(), 700);
        } else {
          showToast(result.message || 'Failed to update profile.', 'error');
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Changes';
          }
        }
      } catch (err) {
        showToast('Network error while saving settings.', 'error');
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Changes';
        }
      }
    });
  }
}

// Profile Information & Password Change Form Handlers
function initProfileForms() {
  const profileForm = document.getElementById('profile-details-form');
  if (profileForm) {
    profileForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const saveBtn = document.getElementById('btn-save-profile');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
      }

      const nameInput = document.getElementById('profileName');
      const emailInput = document.getElementById('profileEmail');
      const emailAlertsCheckbox = document.getElementById('emailAlertsEnabled');

      const payload = {
        name: nameInput ? nameInput.value.trim() : '',
        email: emailInput ? emailInput.value.trim() : '',
        emailAlertsEnabled: emailAlertsCheckbox ? emailAlertsCheckbox.checked : false
      };

      try {
        const res = await fetch('/api/profile/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (result.success) {
          showToast(result.message || 'Profile updated successfully.', 'success');
          setTimeout(() => window.location.reload(), 700);
        } else {
          showToast(result.message || 'Failed to update profile.', 'error');
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Profile';
          }
        }
      } catch (err) {
        showToast('Network error while saving profile.', 'error');
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Profile';
        }
      }
    });
  }

  const passwordForm = document.getElementById('password-change-form');
  if (passwordForm) {
    passwordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const changeBtn = document.getElementById('btn-change-password');
      const currentPassword = document.getElementById('currentPassword').value;
      const newPassword = document.getElementById('newPassword').value;
      const confirmPassword = document.getElementById('confirmPassword').value;

      if (!currentPassword || !newPassword) {
        showToast('Please enter both your current and new password.', 'error');
        return;
      }

      if (newPassword.length < 6) {
        showToast('New password must be at least 6 characters.', 'error');
        return;
      }
      if (newPassword !== confirmPassword) {
        showToast('New password and confirmation do not match.', 'error');
        return;
      }

      if (changeBtn) {
        changeBtn.disabled = true;
        changeBtn.textContent = 'Updating...';
      }

      try {
        const res = await fetch('/api/profile/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
        });
        const result = await res.json();
        if (result.success) {
          showToast(result.message || 'Password changed successfully.', 'success');
          passwordForm.reset();
        } else {
          showToast(result.message || 'Failed to change password.', 'error');
        }
      } catch (err) {
        showToast('Network error while updating password.', 'error');
      } finally {
        if (changeBtn) {
          changeBtn.disabled = false;
          changeBtn.textContent = 'Update Password';
        }
      }
    });
  }
}

// Global Delete Bill confirmation helper
window.deleteBill = async function(billId) {
  if (!confirm('Are you sure you want to delete this bill record?')) {
    return;
  }

  try {
    const res = await fetch(`/api/bills/${billId}`, {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' }
    });
    const result = await res.json();
    if (result.success) {
      showToast('Bill deleted successfully.', 'success');
      setTimeout(() => {
        window.location.href = '/bills';
      }, 500);
    } else {
      showToast(result.message || 'Failed to delete bill.', 'error');
    }
  } catch (err) {
    showToast('Network error while deleting bill.', 'error');
  }
};
