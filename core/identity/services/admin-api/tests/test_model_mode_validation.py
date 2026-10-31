import pytest
from fastapi import HTTPException

from admin_api.app.main import MODEL_MODES, _apply_config_update


def test_antigravity_mode_requires_a_persisted_terms_acknowledgment():
    assert "antigravity" in MODEL_MODES

    with pytest.raises(HTTPException) as error:
        _apply_config_update({}, {"mode": "antigravity"})
    assert error.value.status_code == 422

    configured = _apply_config_update({}, {
        "mode": "antigravity",
        "antigravity_terms_acknowledged": "true",
    })
    assert configured["mode"] == "antigravity"
    assert configured["antigravity_terms_acknowledged"] == "true"

    with pytest.raises(HTTPException):
        _apply_config_update(configured, {"antigravity_terms_acknowledged": ""})


def test_other_model_modes_do_not_require_antigravity_acknowledgment():
    assert _apply_config_update({}, {"mode": "subscription"}) == {"mode": "subscription"}
