from orchestrator.runtime import EventStore
from orchestrator.state import refresh_ledger
from orchestrator.dashboard import generate_dashboard
s=EventStore(); s.emit('orchestrator_initialized',schema_version=3); refresh_ledger(s.root); print(generate_dashboard(s.root))
