from orchestrator.method import load_method


def test_efficiency_controls_are_default_off():
    rules = load_method()["rules"]
    controls = rules["efficiency_controls"]
    for name in ("recon_before_architect", "delegation_guidance", "event_waiting_guidance", "scoped_leads"):
        assert controls[name]["enabled"] is False
    assert controls["file_ownership"]["mode"] == "off"
    canaries = rules["model_canaries"]
    assert canaries["enabled"] is False
    assert all(candidate["percentage"] == 0 for candidate in canaries["candidates"])
    assert canaries["activation_available"] is False
