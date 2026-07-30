"""Infrastructure contract for the browser-hosted unit phase."""

MINIMUM_UNIT_RESULTS = 400


class UnitPhaseFailure(RuntimeError):
    def __init__(self, phase, message):
        self.phase = phase
        super().__init__(f"{phase}: {message}")


def require_unit_result_count(discovered, minimum=MINIMUM_UNIT_RESULTS):
    if discovered < minimum:
        raise UnitPhaseFailure(
            "unit_execution",
            f"discovered {discovered} unit results; expected at least {minimum}",
        )
    return discovered


def unit_phase_failure(phase, error):
    if isinstance(error, UnitPhaseFailure):
        return error
    return UnitPhaseFailure(phase, f"{type(error).__name__}: {error}")
