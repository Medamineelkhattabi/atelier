from __future__ import annotations

import hmac
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from pae.api.deps import SESSION_COOKIE, Auth, authenticate, platform
from pae.db import AuditEntry, AuthSession, User, utcnow
from pae.security import hash_password, new_token, token_hash, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


class Credentials(BaseModel):
    username: str = Field(min_length=2, max_length=64, pattern=r"^[A-Za-z0-9_.\-]+$")
    password: str = Field(min_length=10, max_length=256)


class Setup(Credentials):
    setup_token: str


def _open_session(request: Request, response: Response, user: User) -> dict:
    plat = platform(request)
    token, csrf = new_token(), new_token(16)
    expires = utcnow() + timedelta(hours=plat.config.session_ttl_hours)
    with plat.db.session() as session:
        session.add(AuthSession(token_hash=token_hash(token), user_id=user.id, csrf_token=csrf, expires_at=expires))
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="strict",
        secure=plat.config.cookie_secure,
        max_age=plat.config.session_ttl_hours * 3600,
        path="/",
    )
    return {"username": user.username, "csrf_token": csrf}


@router.get("/state")
def state(request: Request) -> dict:
    plat = platform(request)
    identity = authenticate(request)
    return {
        "has_owner": plat.has_owner(),
        "authenticated": identity is not None,
        "username": identity["actor"] if identity else None,
        "csrf_token": identity["csrf"] if identity else None,
    }


@router.post("/setup")
def setup(body: Setup, request: Request, response: Response) -> dict:
    plat = platform(request)
    if plat.has_owner():
        raise HTTPException(status_code=409, detail="the owner account already exists")
    if not plat.setup_token or not hmac.compare_digest(body.setup_token, plat.setup_token):
        raise HTTPException(status_code=403, detail="invalid setup token (printed in the server log at startup)")
    with plat.db.session() as session:
        user = User(username=body.username, password_hash=hash_password(body.password))
        session.add(user)
        session.add(AuditEntry(actor=body.username, action="owner.created", target=body.username, details={}))
    plat.setup_token = None
    return _open_session(request, response, user)


@router.post("/login")
def login(body: Credentials, request: Request, response: Response) -> dict:
    plat = platform(request)
    key = f"{request.client.host if request.client else '?'}:{body.username.lower()}"
    if not plat.login_limiter.hit(key):
        raise HTTPException(status_code=429, detail="too many login attempts; wait a few minutes")
    with plat.db.session() as session:
        user = session.query(User).filter_by(username=body.username).first()
        valid = user is not None and verify_password(body.password, user.password_hash)
        session.add(
            AuditEntry(
                actor=body.username,
                action="login.success" if valid else "login.failure",
                target=None,
                details={"ip": request.client.host if request.client else None},
            )
        )
    if not valid:
        raise HTTPException(status_code=401, detail="invalid username or password")
    plat.login_limiter.reset(key)
    return _open_session(request, response, user)


@router.post("/logout")
def logout(request: Request, response: Response, identity: dict = Auth) -> dict:
    plat = platform(request)
    cookie = request.cookies.get(SESSION_COOKIE)
    if cookie:
        with plat.db.session() as session:
            row = session.get(AuthSession, token_hash(cookie))
            if row:
                session.delete(row)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=10, max_length=256)


@router.post("/password")
def change_password(body: PasswordChange, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    if identity["kind"] != "session":
        raise HTTPException(status_code=403, detail="only the owner session can change the password")
    with plat.db.session() as session:
        user = session.get(User, identity["user_id"])
        if not verify_password(body.current_password, user.password_hash):
            raise HTTPException(status_code=401, detail="current password is wrong")
        user.password_hash = hash_password(body.new_password)
        session.query(AuthSession).filter(AuthSession.user_id == user.id).delete()
        session.add(AuditEntry(actor=user.username, action="owner.password_changed", target=None, details={}))
    return {"ok": True, "note": "all sessions were signed out"}
