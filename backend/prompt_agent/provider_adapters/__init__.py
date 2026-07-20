"""Provider-specific transports for the Prompt Agent proxy."""

from .registry import adapter_for_profile, capability_report, provider_id_for

__all__ = ["adapter_for_profile", "capability_report", "provider_id_for"]
