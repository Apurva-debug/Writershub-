/*
  WritersClub — realtime data layer (Firebase).

  Requires firebase-config.js to be loaded first (defines `firebaseConfig`),
  plus the Firebase compat SDK scripts. See SETUP.md for the one-time setup.
*/

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const WC = {};

WC.GENRES = ['Romance', 'Fantasy', 'Mystery', 'Sci-Fi', 'Horror', 'Contemporary', 'Thriller', 'Poetry', 'Drama', 'Non-fiction', 'Biography'];

WC.overlaps = function (a, b) {
  return (a || []).some(g => (b || []).includes(g));
};

// Union of every genre across a user's books — kept as a flat top-level
// field so Firestore can query it directly (array-contains-any can't reach
// into genres nested inside array-of-object fields like `books`).
WC.flattenGenres = function (books) {
  const set = new Set();
  (books || []).forEach(b => (b.genres || []).forEach(g => set.add(g)));
  return Array.from(set);
};

// ---------- auth + profile ----------

// Fires once per auth state change with either null (signed out) or the
// signed-in user's full Firestore profile (id + fields).
WC.onAuthReady = function (callback) {
  return auth.onAuthStateChanged(async (u) => {
    if (!u) { callback(null); return; }
    try {
      const doc = await db.collection('users').doc(u.uid).get();
      callback(doc.exists ? Object.assign({ id: u.uid }, doc.data()) : { id: u.uid });
    } catch (e) {
      console.error('WC.onAuthReady', e);
      callback(null);
    }
  });
};

WC.verifyWattpad = function (profileUrl, chaptersClaimed) {
  const looksValid = /wattpad\.com\/user\//i.test(profileUrl.trim());
  if (!looksValid) {
    return { status: 'rejected', reason: "That doesn't look like a Wattpad profile link." };
  }
  if (chaptersClaimed < 1) {
    return { status: 'rejected', reason: 'You need at least one uploaded chapter to join.' };
  }
  return { status: 'auto_approved' };
};

// Creates the Firebase Auth account, then the matching Firestore profile.
// fields.books is an array of { id, title, genres }.
WC.signUpAndCreateProfile = async function (fields) {
  const cred = await auth.createUserWithEmailAndPassword(fields.email, fields.password);
  const uid = cred.user.uid;
  const profile = {
    name: fields.name,
    books: fields.books,
    allWritingGenres: WC.flattenGenres(fields.books),
    readingGenres: fields.readingGenres,
    wattpadProfile: fields.wattpadProfile,
    timeOnWattpad: fields.timeOnWattpad,
    matchMode: fields.matchMode,
    email: fields.email,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  await db.collection('users').doc(uid).set(profile);
  return Object.assign({ id: uid }, profile);
};

WC.logIn = function (email, password) {
  return auth.signInWithEmailAndPassword(email, password);
};

WC.logOut = function () {
  return auth.signOut();
};

// ---------- editing preferences after signup ----------

WC.updateReadingGenres = function (uid, readingGenres) {
  return db.collection('users').doc(uid).update({ readingGenres });
};

// Replaces the whole books list (the dashboard UI edits the array
// client-side, then saves it in one write).
WC.updateBooks = function (uid, books) {
  return db.collection('users').doc(uid).update({
    books,
    allWritingGenres: WC.flattenGenres(books)
  });
};

// ---------- matching ----------

// Finds individual books — not whole profiles — whose genres overlap what
// I like to read. Each result is one book, so someone with 3 books might
// contribute 0, 1, 2 or 3 entries depending on which of their books
// actually fit my reading preferences.
//
// Every result carries bookLink + ownerProfile so the UI can send someone
// straight to the actual Wattpad book (falling back to the writer's
// profile if they never added a direct book link).
WC.findMatches = async function (user) {
  if (!user.readingGenres || !user.readingGenres.length) return [];
  const snap = await db.collection('users')
    .where('allWritingGenres', 'array-contains-any', user.readingGenres.slice(0, 10))
    .get();
  const results = [];
  snap.forEach(doc => {
    if (doc.id === user.id) return;
    const o = Object.assign({ id: doc.id }, doc.data());
    (o.books || []).forEach(book => {
      // only surface this book if its own genres fit what I actually
      // want to read — genres attached to their *other* books don't count
      if (!WC.overlaps(book.genres, user.readingGenres)) return;
      if (user.matchMode === 'mutual' && !WC.overlaps(user.allWritingGenres, o.readingGenres)) return;
      results.push({
        ownerId: o.id,
        ownerName: o.name,
        ownerProfile: o.wattpadProfile || '',
        bookId: book.id,
        bookTitle: book.title,
        bookGenres: book.genres || [],
        bookLink: book.link || ''
      });
    });
  });
  return results;
};

// ---------- search ----------

// Searches every other writer's books by title (case-insensitive substring
// match). Results are never filtered out for not fitting the searcher's
// reading interests — each result just carries `matchesInterest` so the UI
// can show a "doesn't match your interests" note without hiding the book.
//
// NOTE: this pulls every user document client-side, which is fine at
// WritersClub's current scale but won't hold up on a large user base —
// a real search index (e.g. Algolia, or a Cloud Function-maintained
// search collection) is the eventual fix, same spirit as the other
// FIREBASE SWAP POINT notes above.
WC.searchBooks = async function (user, queryText) {
  const q = (queryText || '').trim().toLowerCase();
  if (!q) return [];
  const snap = await db.collection('users').get();
  const results = [];
  snap.forEach(doc => {
    if (doc.id === user.id) return;
    const o = Object.assign({ id: doc.id }, doc.data());
    (o.books || []).forEach(book => {
      const titleMatch = (book.title || '').toLowerCase().includes(q);
      const authorMatch = (o.name || '').toLowerCase().includes(q);
      if (!titleMatch && !authorMatch) return;
      results.push({
        ownerId: o.id,
        ownerName: o.name,
        ownerProfile: o.wattpadProfile || '',
        bookId: book.id,
        bookTitle: book.title,
        bookGenres: book.genres || [],
        bookLink: book.link || '',
        matchesInterest: WC.overlaps(book.genres, user.readingGenres)
      });
    });
  });
  return results;
};

// Given a set of genres (e.g. from a search result the searcher didn't
// love, or just their own reading interests), finds other books that fit —
// used to recommend alternatives alongside search results.
WC.recommendSimilar = async function (user, genres, excludeBookIds) {
  if (!genres || !genres.length) return [];
  const exclude = excludeBookIds || [];
  const snap = await db.collection('users')
    .where('allWritingGenres', 'array-contains-any', genres.slice(0, 10))
    .get();
  const results = [];
  snap.forEach(doc => {
    if (doc.id === user.id) return;
    const o = Object.assign({ id: doc.id }, doc.data());
    (o.books || []).forEach(book => {
      if (exclude.includes(book.id)) return;
      if (!WC.overlaps(book.genres, genres)) return;
      results.push({
        ownerId: o.id,
        ownerName: o.name,
        ownerProfile: o.wattpadProfile || '',
        bookId: book.id,
        bookTitle: book.title,
        bookGenres: book.genres || [],
        bookLink: book.link || ''
      });
    });
  });
  return results.slice(0, 6);
};

// ---------- tasks / confirmation ----------

// `match` is one entry from WC.findMatches or WC.searchBooks (a specific
// book of theirs). Carries bookLink/profile along so the task card can
// still link straight to Wattpad later.
WC.startTask = async function (user, match, days) {
  const deadline = Date.now() + days * 86400000;
  const myFirstBook = (user.books && user.books[0]) || null;
  const matchDoc = {
    participantIds: [user.id, match.ownerId],
    a: { uid: user.id, name: user.name || 'You', book: myFirstBook ? myFirstBook.title : '', confirmed: false },
    b: {
      uid: match.ownerId, name: match.ownerName, book: match.bookTitle, bookId: match.bookId,
      bookLink: match.bookLink || '', profile: match.ownerProfile || '', confirmed: false
    },
    mode: user.matchMode,
    deadline,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  const ref = await db.collection('matches').add(matchDoc);
  return Object.assign({ id: ref.id }, matchDoc);
};

// Live-updates whenever any match this user is part of changes — including
// changes made by the other person, on their own device.
WC.listenToMatches = function (uid, callback) {
  return db.collection('matches')
    .where('participantIds', 'array-contains', uid)
    .onSnapshot(snap => {
      const list = [];
      snap.forEach(doc => list.push(Object.assign({ id: doc.id }, doc.data())));
      callback(list);
    }, err => console.error('WC.listenToMatches', err));
};

WC.confirmMatch = async function (matchId, uid) {
  const ref = db.collection('matches').doc(matchId);
  const doc = await ref.get();
  if (!doc.exists) return null;
  const data = doc.data();
  const field = data.a.uid === uid ? 'a.confirmed' : 'b.confirmed';
  await ref.update({ [field]: true });
};

WC.mySide = function (m, uid) { return m.a.uid === uid ? m.a : m.b; };
WC.theirSide = function (m, uid) { return m.a.uid === uid ? m.b : m.a; };

WC.matchStatus = function (m) {
  if (m.a.confirmed && m.b.confirmed) return 'confirmed';
  if (Date.now() > m.deadline && !(m.a.confirmed && m.b.confirmed)) return 'mismatch';
  return 'pending';
};
// ---------- account management ----------

WC.sendPasswordReset = function (email) {
  return auth.sendPasswordResetEmail(email);
};

WC.changePassword = async function (currentPassword, newPassword) {
  const user = auth.currentUser;
  const cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
  await user.reauthenticateWithCredential(cred);
  await user.updatePassword(newPassword);
};

WC.deleteAccount = async function (currentPassword) {
  const user = auth.currentUser;
  const cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
  await user.reauthenticateWithCredential(cred);
  await db.collection('users').doc(user.uid).delete();
  await user.delete();
};

// ---------- shared UI helper: show/hide password ----------

// Wires a "Show/Hide" toggle button to a password input. Used on every
// page that collects a password (signup, login, change password).
WC.wirePasswordToggle = function (toggleId, inputId) {
  const btn = document.getElementById(toggleId);
  const input = document.getElementById(inputId);
  if (!btn || !input) return;
  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  });
};

        
