/*
  WritersClub — prototype data layer.

  This runs entirely on localStorage right now, so the whole flow works
  immediately on a phone with no setup. Every function that would, in the
  real version, talk to Firebase is marked with:

      // == FIREBASE SWAP POINT ==

  When you're ready to make this work across different people's phones
  (not just one device), replace the inside of those functions with
  Firebase Auth + Firestore calls. The rest of the site (signup.html,
  dashboard.html) never needs to change — they only call these functions.
*/

const WC = {};

// ---------- storage helpers ----------

WC.getUsers = function () {
  return JSON.parse(localStorage.getItem('wc_users') || '[]');
};

WC.saveUsers = function (users) {
  localStorage.setItem('wc_users', JSON.stringify(users));
};

WC.getCurrentUser = function () {
  const id = localStorage.getItem('wc_current_id');
  if (!id) return null;
  return WC.getUsers().find(u => u.id === id) || null;
};

WC.setCurrentUser = function (user) {
  const users = WC.getUsers();
  const idx = users.findIndex(u => u.id === user.id);
  if (idx >= 0) users[idx] = user; else users.push(user);
  WC.saveUsers(users);
  localStorage.setItem('wc_current_id', user.id);
};

// == FIREBASE SWAP POINT ==
// Replace with: Firebase Auth signup (email/password or email link),
// then write the profile fields below into a Firestore "users" collection.
WC.createOrUpdateProfile = function (fields) {
  let user = WC.getCurrentUser();
  if (!user) {
    user = { id: 'u_' + Date.now() };
  }
  Object.assign(user, fields);
  WC.setCurrentUser(user);
  return user;
};

// == FIREBASE SWAP POINT ==
// Replace with a real fetch of the person's public Wattpad profile page
// (or, better, an approved API if Wattpad ever offers one) to confirm the
// profile exists and has at least one published chapter. For now this
// just checks that a profile URL was given and flags anything odd for
// manual review, matching the "hybrid verification" plan.
WC.verifyWattpad = function (profileUrl, chaptersClaimed) {
  const looksValid = /wattpad\.com\/user\//i.test(profileUrl.trim());
  if (!looksValid) {
    return { status: 'rejected', reason: 'That doesn\'t look like a Wattpad profile link.' };
  }
  if (chaptersClaimed < 1) {
    return { status: 'rejected', reason: 'You need at least one uploaded chapter to join.' };
  }
  // In the real version: auto-fetch the page, compare claimed chapter count
  // to what's publicly visible. Mismatches get flagged, not rejected.
  return { status: 'auto_approved' };
};

// ---------- seed demo data so matching has something to match against ----------

WC.ensureSeedUsers = function () {
  if (localStorage.getItem('wc_seeded')) return;
  const seed = [
    { id: 'seed_1', name: 'Alaina R.', bookTitle: 'The Quiet Ledger', writingGenre: 'Mystery',
      readingGenres: ['Fantasy', 'Romance'], matchMode: 'open' },
    { id: 'seed_2', name: 'Devon M.', bookTitle: 'Static Bloom', writingGenre: 'Fantasy',
      readingGenres: ['Mystery', 'Sci-Fi'], matchMode: 'open' },
    { id: 'seed_3', name: 'Priya K.', bookTitle: 'Halfway to Anywhere', writingGenre: 'Romance',
      readingGenres: ['Romance', 'Contemporary'], matchMode: 'mutual' },
    { id: 'seed_4', name: 'Theo B.', bookTitle: 'The Last Signal', writingGenre: 'Sci-Fi',
      readingGenres: ['Fantasy', 'Sci-Fi'], matchMode: 'open' }
  ];
  const users = WC.getUsers();
  seed.forEach(s => { if (!users.find(u => u.id === s.id)) users.push(s); });
  WC.saveUsers(users);
  localStorage.setItem('wc_seeded', '1');
};

// ---------- matching ----------

const GENRES = ['Romance', 'Fantasy', 'Mystery', 'Sci-Fi', 'Horror', 'Contemporary', 'Thriller', 'Poetry', 'Drama'];
WC.GENRES = GENRES;

// == FIREBASE SWAP POINT ==
// Replace with a Firestore query: find users whose readingGenres array
// contains this user's writingGenre (and, for "mutual" mode, whose
// writingGenre is also in this user's readingGenres).
WC.findMatches = function (user) {
  const others = WC.getUsers().filter(u => u.id !== user.id && u.writingGenre);
  return others.filter(o => {
    const readerLikesMyBook = (o.readingGenres || []).includes(user.writingGenre);
    if (!readerLikesMyBook) return false;
    if (user.matchMode === 'mutual') {
      return (user.readingGenres || []).includes(o.writingGenre);
    }
    return true; // open mode — one-directional fit is enough
  });
};

// ---------- tasks / confirmation ----------

WC.getMatches = function () {
  return JSON.parse(localStorage.getItem('wc_active_matches') || '[]');
};

WC.saveActiveMatches = function (list) {
  localStorage.setItem('wc_active_matches', JSON.stringify(list));
};

// == FIREBASE SWAP POINT ==
// Replace with a Firestore document per match, with a deadline timestamp
// and two boolean confirmation fields, one per side.
WC.startTask = function (user, partner, days) {
  const matches = WC.getMatches();
  const deadline = Date.now() + days * 86400000;
  const match = {
    id: 'm_' + Date.now(),
    userId: user.id, userName: user.name || 'You', userBook: user.bookTitle,
    partnerId: partner.id, partnerName: partner.name, partnerBook: partner.bookTitle,
    mode: user.matchMode, deadline,
    userConfirmed: false, partnerConfirmed: false
  };
  matches.push(match);
  WC.saveActiveMatches(matches);
  return match;
};

WC.confirmMatch = function (matchId, side) {
  const matches = WC.getMatches();
  const m = matches.find(x => x.id === matchId);
  if (!m) return null;
  if (side === 'user') m.userConfirmed = true; else m.partnerConfirmed = true;
  WC.saveActiveMatches(matches);
  return m;
};

WC.matchStatus = function (m) {
  if (m.userConfirmed && m.partnerConfirmed) return 'confirmed';
  if (Date.now() > m.deadline && !(m.userConfirmed && m.partnerConfirmed)) return 'mismatch';
  return 'pending';
};
