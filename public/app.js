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

function renderCard() {
  const container = document.getElementById('cardContainer');
  
  if (ideas.length === 0) {
    container.innerHTML = '<div class="empty-state"><h2>🎉 All caught up!</h2><p>Add more ideas in the admin panel<br>or wait for new content tomorrow</p></div>';
    return;
  }
  
  currentIdea = ideas[0];
  const urlHtml = currentIdea.url 
    ? '<a href="' + escapeHtml(currentIdea.url) + '" target="_blank" class="card-url">Read more →</a>' 
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
      '<p class="card-source">📍 ' + escapeHtml(currentIdea.source) + '</p>' +
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
  isDragging = true;
  startX = e.type === 'mousedown' ? e.clientX : e.touches[0].clientX;
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
  
  if (Math.abs(diff) > 100) {
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

// Initialize
checkAuth().then(fetchIdeas);





