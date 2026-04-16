"""ID generation utilities."""
from __future__ import annotations

import secrets
import string
import time
import uuid


def generate_evaluation_id() -> str:
    """Generate a unique evaluation ID.

    Returns:
        Unique evaluation ID string
    """
    timestamp = int(time.time())
    random_part = secrets.token_hex(4)
    return f"eval_{timestamp}_{random_part}"


def generate_recommendation_id(action_type: str, suffix: str = "") -> str:
    """Generate a unique recommendation ID.

    Args:
        action_type: Type of action (e.g., 'hpa', 'vertical')
        suffix: Optional suffix to add

    Returns:
        Unique recommendation ID string
    """
    random_part = secrets.token_hex(3)
    if suffix:
        return f"opt_{action_type}_{suffix}_{random_part}"
    return f"opt_{action_type}_{random_part}"


def generate_execution_id() -> str:
    """Generate a unique execution ID.

    Returns:
        Unique execution ID string
    """
    timestamp = int(time.time())
    random_part = secrets.token_hex(4)
    return f"exec_{timestamp}_{random_part}"


def short_uuid(length: int = 8) -> str:
    """Generate a short UUID.

    Args:
        length: Length of the UUID

    Returns:
        Short UUID string
    """
    return uuid.uuid4().hex[:length]


def generate_api_key(length: int = 32) -> str:
    """Generate a secure API key.

    Args:
        length: Length of the API key

    Returns:
        Secure API key string
    """
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))
