"""Dependency-free FCS 3.1 fixture serializer.

This module deliberately knows nothing about PhaseFinder's scientific models.
It converts explicit event rows and ordered parameter metadata into FCS bytes,
which lets the synthetic benchmark keep data generation independent from the
code being tested.

It is intended for small regression fixtures, not production FCS writing.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import hashlib
import math
import struct
from typing import Sequence


@dataclass(frozen=True)
class Parameter:
    """Ordered FCS parameter metadata."""

    name: str
    stain: str | None = None
    bits: int = 32
    range: int | float = 262_144
    exponent: str = "0,0"
    gain: str = "1"
    unit: str | None = None


@dataclass(frozen=True)
class FCSBuild:
    data: bytes
    text_begin: int
    text_end: int
    data_begin: int
    data_end: int
    supplemental_text_begin: int
    supplemental_text_end: int

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


def _escape_text_token(value: object, delimiter: str) -> str:
    return str(value).replace(delimiter, delimiter * 2)


def _encode_text(pairs: Sequence[tuple[str, object]], delimiter: str) -> bytes:
    if len(delimiter) != 1 or ord(delimiter) > 127:
        raise ValueError("The FCS TEXT delimiter must be one ASCII character.")
    tokens: list[str] = []
    for key, value in pairs:
        tokens.extend((_escape_text_token(key, delimiter), _escape_text_token(value, delimiter)))
    return (delimiter + delimiter.join(tokens) + delimiter).encode("ascii")


def _replace_or_append(
    pairs: list[tuple[str, object]],
    key: str,
    value: object,
) -> None:
    wanted = key.upper().lstrip("$")
    for index, (existing, _) in enumerate(pairs):
        if existing.upper().lstrip("$") == wanted:
            pairs[index] = (existing, value)
            return
    pairs.append((key, value))


def _exact_integer(value: float | int) -> int:
    if isinstance(value, int):
        return value
    numeric = float(value)
    if not math.isfinite(numeric) or not numeric.is_integer():
        raise ValueError(f"Integer DATA value is not an exact integer: {value!r}")
    return int(numeric)


def _encode_byte_aligned_rows(
    rows: Sequence[Sequence[float | int]],
    parameters: Sequence[Parameter],
    datatype: str,
    little_endian: bool,
) -> bytes:
    prefix = "<" if little_endian else ">"
    output = bytearray()
    for event_index, row in enumerate(rows):
        if len(row) != len(parameters):
            raise ValueError(
                f"Event {event_index} has {len(row)} values; expected {len(parameters)}."
            )
        for value, parameter in zip(row, parameters):
            if datatype == "F":
                if parameter.bits != 32:
                    raise ValueError("Float parameters must declare 32 bits.")
                output.extend(struct.pack(prefix + "f", float(value)))
            elif datatype == "D":
                if parameter.bits != 64:
                    raise ValueError("Double parameters must declare 64 bits.")
                output.extend(struct.pack(prefix + "d", float(value)))
            elif datatype == "I":
                width = math.ceil(parameter.bits / 8)
                if width < 1:
                    raise ValueError("Integer parameter widths must be positive.")
                integer = _exact_integer(value)
                if integer < 0 or integer >= 1 << parameter.bits:
                    raise ValueError(
                        f"Integer {integer} does not fit the declared {parameter.bits}-bit field."
                    )
                output.extend(integer.to_bytes(
                    width,
                    byteorder="little" if little_endian else "big",
                    signed=False,
                ))
            else:
                raise ValueError(f"Unsupported fixture datatype: {datatype}")
    return bytes(output)


def _encode_packed_integer_rows(
    rows: Sequence[Sequence[float | int]],
    parameters: Sequence[Parameter],
    little_endian: bool,
) -> bytes:
    """Pack integer fields without padding to byte boundaries.

    This is used only for the deliberately unsupported non-byte-aligned parser
    fixture.  Values are packed continuously in declared field width order.
    """

    values: list[tuple[int, int]] = []
    for event_index, row in enumerate(rows):
        if len(row) != len(parameters):
            raise ValueError(
                f"Event {event_index} has {len(row)} values; expected {len(parameters)}."
            )
        for raw, parameter in zip(row, parameters):
            integer = _exact_integer(raw)
            if parameter.bits < 1 or integer < 0 or integer >= 1 << parameter.bits:
                raise ValueError("Packed integer does not fit its declared bit width.")
            values.append((integer, parameter.bits))

    output = bytearray()
    if little_endian:
        accumulator = 0
        bit_count = 0
        for integer, width in values:
            accumulator |= integer << bit_count
            bit_count += width
            while bit_count >= 8:
                output.append(accumulator & 0xFF)
                accumulator >>= 8
                bit_count -= 8
        if bit_count:
            output.append(accumulator & 0xFF)
    else:
        accumulator = 0
        bit_count = 0
        for integer, width in values:
            accumulator = (accumulator << width) | integer
            bit_count += width
            while bit_count >= 8:
                shift = bit_count - 8
                output.append((accumulator >> shift) & 0xFF)
                accumulator &= (1 << shift) - 1 if shift else 0
                bit_count = shift
        if bit_count:
            output.append((accumulator << (8 - bit_count)) & 0xFF)
    return bytes(output)


def build_fcs(
    rows: Sequence[Sequence[float | int]],
    parameters: Sequence[Parameter],
    *,
    version: str = "FCS3.1",
    datatype: str = "F",
    little_endian: bool = True,
    mode: str = "L",
    nextdata: int = 0,
    timestep: str = "1",
    delimiter: str = "|",
    extra_keywords: Sequence[tuple[str, object]] = (),
    supplemental_keywords: Sequence[tuple[str, object]] = (),
    packed_integers: bool = False,
    header_data_offsets_zero: bool = False,
    metadata_data_offsets: tuple[int, int] | None = None,
    truncate_data_bytes: int = 0,
) -> FCSBuild:
    """Return one complete FCS byte sequence and its physical segment offsets.

    ``metadata_data_offsets`` and ``truncate_data_bytes`` intentionally permit
    malformed fixtures.  Physical offsets in the returned dataclass always
    describe where the serializer placed the untruncated DATA segment.
    """

    datatype = datatype.upper()
    if not parameters:
        raise ValueError("At least one FCS parameter is required.")
    if datatype in {"F", "D"} and packed_integers:
        raise ValueError("packed_integers is only valid for datatype I.")

    if datatype == "I" and packed_integers:
        encoded_data = _encode_packed_integer_rows(rows, parameters, little_endian)
    else:
        encoded_data = _encode_byte_aligned_rows(
            rows, parameters, datatype, little_endian
        )

    byteord = "1,2,3,4" if little_endian else "4,3,2,1"
    base_pairs: list[tuple[str, object]] = [
        ("$BEGINANALYSIS", "0"),
        ("$ENDANALYSIS", "0"),
        ("$BYTEORD", byteord),
        ("$DATATYPE", datatype),
        ("$MODE", mode),
        ("$NEXTDATA", str(nextdata)),
        ("$PAR", str(len(parameters))),
        ("$TOT", str(len(rows))),
        ("$TIMESTEP", timestep),
    ]
    for index, parameter in enumerate(parameters, start=1):
        base_pairs.extend([
            (f"$P{index}B", str(parameter.bits)),
            (f"$P{index}E", parameter.exponent),
            (f"$P{index}N", parameter.name),
            (f"$P{index}R", str(parameter.range)),
            (f"$P{index}S", parameter.stain or parameter.name),
            (f"$P{index}G", parameter.gain),
        ])
        if parameter.unit is not None:
            base_pairs.append((f"$P{index}U", parameter.unit))
    for key, value in extra_keywords:
        _replace_or_append(base_pairs, key, value)

    text_begin = 58
    physical_data_begin = 0
    physical_data_end = 0
    supplemental_begin = 0
    supplemental_end = 0
    text_bytes = b""
    supplemental_bytes = (
        _encode_text(supplemental_keywords, delimiter)
        if supplemental_keywords
        else b""
    )

    for _ in range(32):
        pairs = list(base_pairs)
        if supplemental_bytes:
            _replace_or_append(pairs, "$BEGINSTEXT", supplemental_begin)
            _replace_or_append(pairs, "$ENDSTEXT", supplemental_end)
        declared_begin, declared_end = (
            metadata_data_offsets
            if metadata_data_offsets is not None
            else (physical_data_begin, physical_data_end)
        )
        _replace_or_append(pairs, "$BEGINDATA", declared_begin)
        _replace_or_append(pairs, "$ENDDATA", declared_end)
        next_text = _encode_text(pairs, delimiter)
        text_end = text_begin + len(next_text) - 1
        next_supplemental_begin = text_end + 1 if supplemental_bytes else 0
        next_supplemental_end = (
            next_supplemental_begin + len(supplemental_bytes) - 1
            if supplemental_bytes
            else 0
        )
        next_data_begin = (
            next_supplemental_end + 1 if supplemental_bytes else text_end + 1
        )
        next_data_end = next_data_begin + len(encoded_data) - 1

        stable = (
            next_text == text_bytes
            and next_data_begin == physical_data_begin
            and next_data_end == physical_data_end
            and next_supplemental_begin == supplemental_begin
            and next_supplemental_end == supplemental_end
        )
        text_bytes = next_text
        physical_data_begin = next_data_begin
        physical_data_end = next_data_end
        supplemental_begin = next_supplemental_begin
        supplemental_end = next_supplemental_end
        if stable:
            break
    else:
        raise RuntimeError("FCS TEXT/DATA offsets did not converge.")

    text_end = text_begin + len(text_bytes) - 1
    header_data_begin = 0 if header_data_offsets_zero else physical_data_begin
    header_data_end = 0 if header_data_offsets_zero else physical_data_end
    if len(version) > 6:
        raise ValueError("FCS version field may contain at most six characters.")
    header = (
        f"{version:<6}    "
        f"{text_begin:>8}{text_end:>8}"
        f"{header_data_begin:>8}{header_data_end:>8}{0:>8}{0:>8}"
    ).encode("ascii")
    if len(header) != 58:
        raise RuntimeError(f"Invalid FCS header length: {len(header)}")

    if truncate_data_bytes < 0 or truncate_data_bytes > len(encoded_data):
        raise ValueError("truncate_data_bytes is outside the DATA segment.")
    stored_data = encoded_data[
        : len(encoded_data) - truncate_data_bytes if truncate_data_bytes else None
    ]
    blob = header + text_bytes + supplemental_bytes + stored_data
    return FCSBuild(
        data=blob,
        text_begin=text_begin,
        text_end=text_end,
        data_begin=physical_data_begin,
        data_end=physical_data_end,
        supplemental_text_begin=supplemental_begin,
        supplemental_text_end=supplemental_end,
    )


def write_fcs(path: Path, *args, **kwargs) -> FCSBuild:
    """Build and atomically-ish replace a small fixture at ``path``."""

    build = build_fcs(*args, **kwargs)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(build.data)
    temporary.replace(path)
    return build


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
