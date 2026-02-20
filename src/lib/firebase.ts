import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';

/**
 * Firebase Admin SDK singleton.
 *
 * Uses `preferRest: true` to reduce cold start overhead by skipping
 * gRPC channel initialization.
 */

let _app: App | null = null;
let _db: Firestore | null = null;
let _auth: Auth | null = null;

function getApp(): App {
  if (_app) return _app;

  if (getApps().length > 0) {
    _app = getApps()[0];
    return _app;
  }

  _app = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });

  return _app;
}

export function getDb(): Firestore {
  if (_db) return _db;
  _db = getFirestore(getApp());
  _db.settings({ preferRest: true });
  return _db;
}

export function getAdminAuth(): Auth {
  if (_auth) return _auth;
  _auth = getAuth(getApp());
  return _auth;
}
