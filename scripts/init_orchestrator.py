from orchestrator.runtime import EventStore
from orchestrator.state import rebuild
from orchestrator.dashboard import generate_dashboard
s=EventStore(); s.emit('orchestrator_initialized',schema_version=3); rebuild(); print(generate_dashboard())
