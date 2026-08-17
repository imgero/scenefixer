"""Firebase Admin SDK initialization for Modal functions."""

import json
import os
import modal
import firebase_admin
from firebase_admin import credentials, firestore, storage

_initialized = False


def init_firebase():
    global _initialized
    if _initialized or firebase_admin._apps:
        return

    # In production: load from Modal secret
    # modal secret create firebase-admin-key  (paste the full service account JSON)
    secret_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if not secret_json:
        raise RuntimeError("FIREBASE_SERVICE_ACCOUNT_JSON not set in Modal secrets")

    cred_dict = json.loads(secret_json)
    cred = credentials.Certificate(cred_dict)
    firebase_admin.initialize_app(
        cred,
        {"storageBucket": os.environ.get("FIREBASE_STORAGE_BUCKET")},
    )
    _initialized = True


def get_db():
    init_firebase()
    return firestore.client()


def get_bucket():
    init_firebase()
    return storage.bucket()
