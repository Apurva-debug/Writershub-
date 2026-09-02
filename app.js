/*
  WritersClub — realtime data layer (Firebase).

  Requires firebase-config.js to be loaded first (defines `firebaseConfig`),
  plus the Firebase compat SDK scripts. See SETUP.md for the one-time setup.
*/

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const WC = {};

WC.GENRES = ['Romance', 'Fantasy', 'Mystery', 'Sci-Fi', 'Horror', 'Contemporary', 'Thriller', 'Poetry', 'Drama'];

WC.overlaps = function (a, b) {
  return (a || []).some(g => (b || []).includes(g));
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
WC.signUpAndCreateProfile = async function (fields) {
  const cred = await auth.createUserWithEmailAndPassword(fields.email, fields.password);
  const uid = cred.user.uid;
  const profile = {
    name: fields.name,
    bookTitle: fields.bookTitle,
    writingGenres: fields.writingGenres,
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

// ---------- matching ----------

// Finds other writers whose book genre fits what I like to read (and, in
// mutual mode, whose reading taste fits my book too).
WC.findMatches = async function (user) {
  if (!user.readingGenres || !user.readingGenres.length) return [];
  const snap = await db.collection('users')
    .where('writingGenres', 'array-contains-any', user.readingGenres.slice(0, 10))
    .get();
  const others = [];
  snap.forEach(doc => {
    if (doc.id === user.id) return;
    const o = Object.assign({ id: doc.id }, doc.data());
    if (user.matchMode === 'mutual' && !WC.overlaps(user.writingGenres, o.readingGenres)) return;
    others.push(o);
  });
  return others;
};

// ---------- tasks / confirmation ----------

WC.startTask = async function (user, partner, days) {
  const deadline = Date.now() + days * 86400000;
  const match = {
    participantIds: [user.id, partner.id],
    a: { uid: user.id, name: user.name || 'You', book: user.bookTitle, confirmed: false },
    b: { uid: partner.id, name: partner.name, book: partner.bookTitle, confirmed: false },
    mode: user.matchMode,
    deadline,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  const ref = await db.collection('matches').add(match);
  return Object.assign({ id: ref.id }, match);
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
