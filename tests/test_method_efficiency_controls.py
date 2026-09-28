import json

import pytest

from orchestrator.method import load_method


def test_efficiency_controls_are_default_off():
    rules = load_method()["rules"]
    controls = rules["efficiency_controls"]
    for name in ("delegation_guidance", "event_waiting_guidance"):
        assert controls[name]["enabled"] is False
    assert "scoped_leads" not in controls
    assert "recon_before_architect" not in controls
    assert controls["file_ownership"]["mode"] == "off"
    canaries = rules["model_canaries"]
    assert canaries["enabled"] is False
    assert all(candidate["percentage"] == 0 for candidate in canaries["candidates"])
    assert canaries["activation_available"] is False


@pytest.mark.parametrize("name", ["scoped_leads", "recon_before_architect"])
def test_removed_efficiency_switches_rejected_by_python_loader(tmp_path, name):
    method = load_method()
    method["rules"]["efficiency_controls"][name] = {"enabled": True}
    path = tmp_path / "method.json"
    path.write_text(json.dumps(method))
    with pytest.raises(ValueError, match=name):
        load_method(path)


def test_serialize_ownership_rejected_by_python_loader(tmp_path):
    method = load_method()
    method["rules"]["efficiency_controls"]["file_ownership"]["mode"] = "serialize"
    path = tmp_path / "method.json"
    path.write_text(json.dumps(method))
    with pytest.raises(ValueError, match="serialize"):
        load_method(path)
