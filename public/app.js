let ideas = [];
let currentIdea = null;
let startX = 0;
let currentX = 0;
let isDragging = false;
let currentUser = null;
let lastSwipe = null; // Track last swipe for undo

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
  // Don't trigger shortcuts when typing in input fields
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
    // Allow Ctrl/Cmd+Enter to submit feedback
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submitFeedback(false);
    }
    return;
  }
  
  // Don't trigger if modal is open
  const modal = document.getElementById('feedbackModal');
  if (modal && modal.classList.contains('active')) return;
  
  switch(e.key) {
    case 'ArrowLeft':
    case 'j':
      e.preventDefault();
      swipeCard('left');
      break;
    case 'ArrowRight':
    case 'k':
    case 'l':
      e.preventDefault();
      swipeCard('right');
      break;
    case 'u':
    case 'z':
      e.preventDefault();
      undoSwipe();
      break;
  }
});

// Check auth state on load
async function checkAuth() {
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    currentUser = data.user;
    
    if (currentUser) {
      const userInfo = document.getElementById('userInfo');
      if (userInfo) {
        userInfo.innerHTML = 
          '<span class="user-email">' + escapeHtml(currentUser.email) + '</span> ' +
          '<a href="/auth/logout" class="logout-btn">Logout</a>';
        userInfo.style.display = 'block';
      }
    } else {
      window.location.href = '/login';
    }
  } catch (e) {
    console.error('Auth check failed:', e);
    window.location.href = '/login';
  }
}

async function fetchIdeas() {
  const res = await fetch('/api/ideas');
  if (res.status === 401) {
    window.location.href = '/login';
    return;
  }
  const data = await res.json();
  ideas = data.unswiped;
  document.getElementById('remaining').textContent = ideas.length;
  document.getElementById('liked').textContent = data.likedCount;
  renderCard();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  
  const now = new Date();
  const diffMs = now - d;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  
  if (diffHours < 1) {
    const diffMins = Math.floor(diffMs / (1000 * 60));
    return ' · ' + diffMins + 'm ago';
  } else if (diffHours < 24) {
    return ' · ' + diffHours + 'h ago';
  } else {
    return ' · ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
}

function renderCard() {
  const container = document.getElementById('cardContainer');
  
  if (ideas.length === 0) {
    container.innerHTML = '<div class="empty-state"><h2>🎉 All caught up!</h2><p>Check back later for new content</p><button class="action-btn btn-refresh" onclick="refreshFeeds()" id="refreshBtn" title="Refresh feeds">🔄</button></div>';
    return;
  }
  
  currentIdea = ideas[0];
  const urlHtml = currentIdea.url 
    ? '<a href="' + escapeHtml(currentIdea.url) + '" target="_blank" class="card-url" onclick="event.stopPropagation()" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()">Read more →</a>' 
    : '';
  
  // Content type badge
  const contentTypeIcons = {
    'video': '📹',
    'article': '📄',
    'changelog': '🔄',
    'paper': '📚',
    'release': '🚀'
  };
  const contentType = currentIdea.content_type || 'article';
  const contentTypeIcon = contentTypeIcons[contentType] || '📄';
  const contentTypeBadge = '<span class="content-type-badge" title="' + contentType + '">' + contentTypeIcon + '</span>';
  
  container.innerHTML = 
    '<div class="card" id="currentCard">' +
      '<div class="swipe-indicator left">NOPE</div>' +
      '<div class="swipe-indicator right">SAVE</div>' +
      '<div class="card-badges">' +
        '<span class="card-category">' + (currentIdea.category || 'update') + '</span>' +
        contentTypeBadge +
      '</div>' +
      '<h2 class="card-title">' + escapeHtml(currentIdea.title) + '</h2>' +
      '<p class="card-source">📍 ' + escapeHtml(currentIdea.source) + formatDate(currentIdea.published_at) + '</p>' +
      '<p class="card-summary">' + escapeHtml(currentIdea.summary) + '</p>' +
      urlHtml +
    '</div>';
  
  setupDragListeners();
}

function setupDragListeners() {
  const card = document.getElementById('currentCard');
  if (!card) return;
  
  card.addEventListener('mousedown', startDrag);
  card.addEventListener('touchstart', startDrag, { passive: true });
  document.addEventListener('mousemove', drag);
  document.addEventListener('touchmove', drag, { passive: false });
  document.addEventListener('mouseup', endDrag);
  document.addEventListener('touchend', endDrag);
}

function startDrag(e) {
  // Don't start drag if clicking on a link
  if (e.target.tagName === 'A' || e.target.closest('a')) return;
  
  isDragging = true;
  startX = e.type === 'mousedown' ? e.clientX : e.touches[0].clientX;
  currentX = startX;  // Initialize so clicks without movement have diff=0
  const card = document.getElementById('currentCard');
  if (card) card.classList.add('dragging');
}

function drag(e) {
  if (!isDragging) return;
  e.preventDefault();
  
  currentX = e.type === 'mousemove' ? e.clientX : e.touches[0].clientX;
  const diff = currentX - startX;
  const card = document.getElementById('currentCard');
  if (!card) return;
  
  const rotation = diff * 0.1;
  card.style.transform = 'translateX(' + diff + 'px) rotate(' + rotation + 'deg)';
  
  const leftIndicator = card.querySelector('.swipe-indicator.left');
  const rightIndicator = card.querySelector('.swipe-indicator.right');
  
  if (diff < -50) {
    leftIndicator.style.opacity = Math.min(1, Math.abs(diff) / 100);
    rightIndicator.style.opacity = 0;
  } else if (diff > 50) {
    rightIndicator.style.opacity = Math.min(1, diff / 100);
    leftIndicator.style.opacity = 0;
  } else {
    leftIndicator.style.opacity = 0;
    rightIndicator.style.opacity = 0;
  }
}

function endDrag() {
  if (!isDragging) return;
  isDragging = false;
  
  const diff = currentX - startX;
  const card = document.getElementById('currentCard');
  if (!card) return;
  
  card.classList.remove('dragging');
  
  // Require significant movement (150px) to trigger swipe
  // This prevents accidental swipes from clicks or small movements
  if (Math.abs(diff) > 150) {
    swipeCard(diff > 0 ? 'right' : 'left');
  } else {
    card.style.transform = '';
    card.querySelector('.swipe-indicator.left').style.opacity = 0;
    card.querySelector('.swipe-indicator.right').style.opacity = 0;
  }
}

async function swipeCard(direction) {
  const card = document.getElementById('currentCard');
  if (!card || !currentIdea) return;
  
  card.classList.add(direction === 'left' ? 'swiping-left' : 'swiping-right');
  
  if (direction === 'right') {
    setTimeout(function() {
      document.getElementById('feedbackModal').classList.add('active');
    }, 300);
  } else {
    // Track for undo before removing
    lastSwipe = { ideaId: currentIdea.id, direction: 'left', feedback: null, idea: currentIdea };
    
    await fetch('/api/swipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentIdea.id, direction: 'left', feedback: null })
    });
    
    ideas.shift();
    document.getElementById('remaining').textContent = ideas.length;
    setTimeout(renderCard, 300);
  }
}

async function submitFeedback(skip) {
  const feedback = skip ? null : document.getElementById('feedbackText').value;
  
  // Track for undo before submitting
  lastSwipe = { ideaId: currentIdea.id, direction: 'right', feedback: feedback, idea: currentIdea };
  
  await fetch('/api/swipe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: currentIdea.id, direction: 'right', feedback: feedback })
  });
  
  document.getElementById('feedbackModal').classList.remove('active');
  document.getElementById('feedbackText').value = '';
  
  ideas.shift();
  document.getElementById('remaining').textContent = ideas.length;
  document.getElementById('liked').textContent = parseInt(document.getElementById('liked').textContent) + 1;
  renderCard();
}

function toggleAdmin() {
  const panel = document.getElementById('adminPanel');
  panel.classList.toggle('active');
  if (panel.classList.contains('active')) {
    loadLikedIdeas();
    loadUserFeeds();
  }
}

async function addIdea() {
  const idea = {
    title: document.getElementById('newTitle').value,
    source: document.getElementById('newSource').value,
    category: document.getElementById('newCategory').value,
    summary: document.getElementById('newSummary').value,
    url: document.getElementById('newUrl').value
  };
  
  if (!idea.title || !idea.source || !idea.summary) {
    alert('Please fill in title, source, and summary');
    return;
  }
  
  await fetch('/api/ideas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(idea)
  });
  
  document.getElementById('newTitle').value = '';
  document.getElementById('newSource').value = '';
  document.getElementById('newSummary').value = '';
  document.getElementById('newUrl').value = '';
  
  alert('Idea added!');
  fetchIdeas();
}

async function loadLikedIdeas() {
  const res = await fetch('/api/liked');
  const liked = await res.json();
  
  const container = document.getElementById('likedIdeas');
  if (liked.length === 0) {
    container.innerHTML = '<p style="color:#666">No saved ideas yet</p>';
    return;
  }
  
  container.innerHTML = liked.map(function(idea) {
    const feedbackHtml = idea.feedback 
      ? '<div class="liked-item-feedback">"' + escapeHtml(idea.feedback) + '"</div>'
      : '';
    return '<div class="liked-item">' +
      '<div class="liked-item-title">' + escapeHtml(idea.title) + '</div>' +
      '<div class="liked-item-source">' + escapeHtml(idea.source) + '</div>' +
      feedbackHtml +
    '</div>';
  }).join('');
}

async function showSavedIdeas() {
  const res = await fetch('/api/liked');
  const liked = await res.json();
  
  const container = document.getElementById('savedIdeasList');
  if (liked.length === 0) {
    container.innerHTML = '<p style="color:#666; text-align: center;">No saved ideas yet. Swipe right on ideas you like!</p>';
  } else {
    container.innerHTML = liked.map(function(idea) {
      const feedbackHtml = idea.feedback 
        ? '<div style="color: #888; font-size: 0.9em; font-style: italic; margin-top: 5px;">"' + escapeHtml(idea.feedback) + '"</div>'
        : '';
      const urlHtml = idea.url
        ? '<a href="' + escapeHtml(idea.url) + '" target="_blank" style="color: #4ecdc4; font-size: 0.85em;">Open →</a>'
        : '';
      return '<div style="background: #1f1f35; border-radius: 10px; padding: 12px; margin-bottom: 10px;">' +
        '<div style="font-weight: 600; margin-bottom: 3px;">' + escapeHtml(idea.title) + '</div>' +
        '<div style="color: #feca57; font-size: 0.85em;">' + escapeHtml(idea.source) + ' ' + urlHtml + '</div>' +
        feedbackHtml +
      '</div>';
    }).join('');
  }
  
  document.getElementById('savedModal').classList.add('active');
}

function closeSavedModal() {
  document.getElementById('savedModal').classList.remove('active');
}

// Close saved modal when clicking outside
document.addEventListener('click', function(e) {
  const modal = document.getElementById('savedModal');
  if (e.target === modal) {
    closeSavedModal();
  }
});

async function downloadSavedIdeas() {
  const res = await fetch('/api/liked');
  const liked = await res.json();
  
  const blob = new Blob([JSON.stringify(liked, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'saved-ideas-' + new Date().toISOString().split('T')[0] + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function exportData() {
  window.location.href = '/api/export';
}

async function deleteAccount() {
  if (!confirm('Are you sure you want to delete your account? This cannot be undone.')) {
    return;
  }
  if (!confirm('Really delete? All your swipe history and feedback will be permanently deleted.')) {
    return;
  }
  
  const res = await fetch('/api/delete-account', { method: 'POST' });
  if (res.redirected) {
    window.location.href = res.url;
  }
}

async function undoSwipe() {
  if (!lastSwipe) {
    // Show brief message that there's nothing to undo
    const container = document.getElementById('cardContainer');
    const existing = document.getElementById('undoMessage');
    if (existing) existing.remove();
    
    const msg = document.createElement('div');
    msg.id = 'undoMessage';
    msg.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:8px;z-index:1000;';
    msg.textContent = 'Nothing to undo';
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 2000);
    return;
  }
  
  const res = await fetch('/api/undo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ideaId: lastSwipe.ideaId })
  });
  
  if (res.ok) {
    const data = await res.json();
    // Put the idea back at the front of the queue
    ideas.unshift(lastSwipe.idea);
    document.getElementById('remaining').textContent = ideas.length;
    if (data.wasRight) {
      document.getElementById('liked').textContent = parseInt(document.getElementById('liked').textContent) - 1;
    }
    renderCard();
    
    // Show undo confirmation
    const msg = document.createElement('div');
    msg.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:#4ecdc4;color:#fff;padding:10px 20px;border-radius:8px;z-index:1000;';
    msg.textContent = 'Undo successful! (press U to undo again)';
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 2000);
  }
  
  lastSwipe = null;
}

// Refresh feeds manually
async function refreshFeeds() {
  const btn = document.getElementById('refreshBtn');
  if (btn) {
    btn.classList.add('spinning');
    btn.disabled = true;
  }
  
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const data = await res.json();
    
    if (res.ok) {
      // Reload ideas to show new content - stats will update automatically
      await fetchIdeas();
    } else if (res.status === 429) {
      // Rate limited - worth telling them
      alert(data.error);
    }
  } catch (e) {
    console.error('Refresh error:', e);
  } finally {
    if (btn) {
      btn.classList.remove('spinning');
      btn.disabled = false;
    }
  }
}

// Initialize
checkAuth().then(fetchIdeas);

// Feed management functions
async function loadUserFeeds() {
  try {
    const res = await fetch('/api/feeds');
    const feeds = await res.json();
    const container = document.getElementById('userFeeds');
    
    if (!feeds.length) {
      container.innerHTML = '<p style="color: #666;">No custom feeds yet. Add one below!</p>';
      return;
    }
    
    container.innerHTML = feeds.map(function(feed) {
      const statusClass = feed.last_error ? 'feed-error' : (feed.enabled ? 'feed-active' : 'feed-disabled');
      const statusText = feed.last_error ? '⚠️' : (feed.enabled ? '✓' : '○');
      return '<div class="feed-item ' + statusClass + '">' +
        '<div class="feed-info">' +
          '<span class="feed-status">' + statusText + '</span>' +
          '<span class="feed-name">' + escapeHtml(feed.name) + '</span>' +
          '<span class="feed-category">' + escapeHtml(feed.category) + '</span>' +
        '</div>' +
        '<div class="feed-actions">' +
          '<button onclick="toggleFeed(' + feed.id + ', ' + !feed.enabled + ')" class="feed-btn">' + 
            (feed.enabled ? 'Disable' : 'Enable') + 
          '</button>' +
          '<button onclick="deleteFeed(' + feed.id + ')" class="feed-btn delete">Delete</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    console.error('Failed to load feeds:', e);
  }
}

async function addFeed() {
  const url = document.getElementById('newFeedUrl').value.trim();
  const name = document.getElementById('newFeedName').value.trim();
  const category = document.getElementById('newFeedCategory').value;
  
  if (!url || !name) {
    alert('Please enter both URL and name');
    return;
  }
  
  try {
    const res = await fetch('/api/feeds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, name, category })
    });
    
    const data = await res.json();
    if (data.error) {
      alert('Error: ' + data.error);
      return;
    }
    
    document.getElementById('newFeedUrl').value = '';
    document.getElementById('newFeedName').value = '';
    loadUserFeeds();
  } catch (e) {
    alert('Failed to add feed');
  }
}

async function toggleFeed(feedId, enabled) {
  try {
    await fetch('/api/feeds/' + feedId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    loadUserFeeds();
  } catch (e) {
    alert('Failed to update feed');
  }
}

async function deleteFeed(feedId) {
  if (!confirm('Delete this feed?')) return;
  
  try {
    await fetch('/api/feeds/' + feedId, { method: 'DELETE' });
    loadUserFeeds();
  } catch (e) {
    alert('Failed to delete feed');
  }
}

// MCP Token management
async function showMcpToken() {
  try {
    const res = await fetch('/api/mcp-token');
    const data = await res.json();
    
    document.getElementById('mcpEndpoint').value = data.endpoint;
    document.getElementById('mcpTokenDisplay').style.display = 'block';
    document.getElementById('mcpShowBtn').style.display = 'none';
  } catch (e) {
    alert('Failed to load MCP token');
  }
}

function copyMcpEndpoint() {
  const input = document.getElementById('mcpEndpoint');
  input.select();
  document.execCommand('copy');
  
  const btn = event.target;
  const original = btn.textContent;
  btn.textContent = '✓ Copied!';
  setTimeout(() => btn.textContent = original, 2000);
}

async function regenerateMcpToken() {
  if (!confirm('Regenerate token? Your old token will stop working immediately.')) return;
  
  try {
    const res = await fetch('/api/mcp-token', { method: 'POST' });
    const data = await res.json();
    
    document.getElementById('mcpEndpoint').value = data.endpoint;
    alert('Token regenerated! Update your AI settings with the new endpoint.');
  } catch (e) {
    alert('Failed to regenerate token');
  }
}























