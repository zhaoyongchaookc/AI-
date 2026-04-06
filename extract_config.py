#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zipfile import ZipFile
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
JSON_PATH = DATA_DIR / "loan-config.json"
JS_PATH = DATA_DIR / "loan-config.js"

CADILLAC_FILE = ROOT / "【202604适用】凯迪拉克_月供试算参考表_V1.xlsx"
BUICK_FILE = ROOT / "【202604适用】别克_月供试算参考表_V1.xlsx"
FISCAL_FILE = ROOT / "财政贴息试算参考表.xlsx"

NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "pkgrel": "http://schemas.openxmlformats.org/package/2006/relationships",
}


def round_up(value: float, digits: int = 2) -> float:
    factor = 10 ** digits
    return math.ceil(value * factor - 1e-9) / factor


def round_money(value: float) -> float:
    return round(value + 0.0, 2)


def maybe_float(value: Any) -> float | None:
    if value in (None, "", "无方案"):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    text = text.replace("%", "")
    try:
        return float(text)
    except ValueError:
        return None


def text_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def to_slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def excel_serial_to_date(serial: float) -> str:
    base = datetime(1899, 12, 30)
    return (base + timedelta(days=float(serial))).date().isoformat()


@dataclass
class Cell:
    ref: str
    value: Any = None
    formula: str | None = None


class Workbook:
    def __init__(self, path: Path):
        self.path = path
        self._zip = ZipFile(path)
        self.shared_strings = self._load_shared_strings()
        self.sheet_targets = self._load_sheet_targets()
        self.sheet_cache: dict[str, dict[str, Cell]] = {}

    def close(self) -> None:
        self._zip.close()

    def _load_shared_strings(self) -> list[str]:
        if "xl/sharedStrings.xml" not in self._zip.namelist():
            return []
        root = ET.fromstring(self._zip.read("xl/sharedStrings.xml"))
        items = []
        for si in root.findall("main:si", NS):
            items.append("".join(node.text or "" for node in si.iterfind(".//main:t", NS)))
        return items

    def _load_sheet_targets(self) -> dict[str, str]:
        rels_root = ET.fromstring(self._zip.read("xl/_rels/workbook.xml.rels"))
        rels = {
            rel.attrib["Id"]: rel.attrib["Target"] for rel in rels_root.findall("pkgrel:Relationship", NS)
        }
        workbook = ET.fromstring(self._zip.read("xl/workbook.xml"))
        mapping: dict[str, str] = {}
        for sheet in workbook.find("main:sheets", NS):
            rid = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
            target = rels[rid]
            if not target.startswith("xl/"):
                target = "xl/" + target.lstrip("/")
            mapping[sheet.attrib["name"]] = target
        return mapping

    def load_sheet(self, name: str) -> dict[str, Cell]:
        if name in self.sheet_cache:
            return self.sheet_cache[name]
        target = self.sheet_targets[name]
        root = ET.fromstring(self._zip.read(target))
        cells: dict[str, Cell] = {}
        for node in root.iterfind(".//main:sheetData/main:row/main:c", NS):
            ref = node.attrib["r"]
            formula_node = node.find("main:f", NS)
            value_node = node.find("main:v", NS)
            inline = node.find("main:is", NS)
            value: Any = None
            if node.attrib.get("t") == "s" and value_node is not None and value_node.text is not None:
                value = self.shared_strings[int(value_node.text)]
            elif node.attrib.get("t") == "inlineStr" and inline is not None:
                value = "".join(t.text or "" for t in inline.iterfind(".//main:t", NS))
            elif value_node is not None:
                value = self._coerce_numeric(value_node.text)
            cells[ref] = Cell(
                ref=ref,
                value=value,
                formula=formula_node.text if formula_node is not None else None,
            )
        self.sheet_cache[name] = cells
        return cells

    @staticmethod
    def _coerce_numeric(text: str | None) -> Any:
        if text is None:
            return None
        value = text.strip()
        if not value:
            return None
        try:
            number = float(value)
            if abs(number - round(number)) < 1e-12:
                return int(round(number))
            return number
        except ValueError:
            return value

    def cell(self, sheet: str, ref: str) -> Cell:
        return self.load_sheet(sheet).get(ref, Cell(ref=ref))

    def value(self, sheet: str, ref: str, default: Any = None) -> Any:
        cell = self.cell(sheet, ref)
        return cell.value if cell.value not in (None, "") else default

    def formula(self, sheet: str, ref: str) -> str | None:
        return self.cell(sheet, ref).formula

    def rows(self, sheet: str) -> dict[int, dict[str, Cell]]:
        grouped: dict[int, dict[str, Cell]] = {}
        for ref, cell in self.load_sheet(sheet).items():
            match = re.match(r"([A-Z]+)(\d+)", ref)
            if not match:
                continue
            col, row = match.group(1), int(match.group(2))
            grouped.setdefault(row, {})[col] = cell
        return grouped


def cell_number(row: dict[str, Cell], col: str) -> float | None:
    cell = row.get(col)
    if not cell:
        return None
    return maybe_float(cell.value)


def cell_text(row: dict[str, Cell], col: str) -> str | None:
    cell = row.get(col)
    if not cell:
        return None
    return text_or_none(cell.value)


def build_fixture(
    name: str,
    brand: str,
    application_type: str,
    plan_key: str,
    category: str,
    term: int,
    inputs: dict[str, Any],
    expected: dict[str, Any],
) -> dict[str, Any]:
    return {
        "name": name,
        "brand": brand,
        "applicationType": application_type,
        "planKey": plan_key,
        "planCategory": category,
        "term": term,
        "inputs": inputs,
        "expected": expected,
    }


def plan_key(*parts: str) -> str:
    return "-".join(to_slug(part) for part in parts if part)


def parse_cadillac(wb: Workbook) -> dict[str, Any]:
    model_rows = wb.rows("厂贴车型明细&贷款金额说明")
    factor_rows = wb.rows("系数参数")
    offers: list[dict[str, Any]] = []
    fixtures: list[dict[str, Any]] = []

    series_mins: dict[str, dict[int, float]] = {}
    for row_idx in range(10, 70):
        row = model_rows.get(row_idx, {})
        series = cell_text(row, "H")
        if series:
            series_mins[series] = {
                60: cell_number(row, "I") or 0,
                48: cell_number(row, "J") or 0,
                36: cell_number(row, "K") or 0,
                24: cell_number(row, "L") or 0,
            }

    current_group = None
    models: list[dict[str, Any]] = []
    group_to_series = {
        "新款CT5": "CT5_",
        "老款CT5": "CT5_",
        "新款XT5": "全新XT5",
        "新款XT6": "XT6_",
        "新CT6": "新CT6",
        "CT6": "CT6_",
        "XT4": "XT4_",
        "傲歌": "傲歌",
    }

    for row_idx in range(10, 70):
        row = model_rows.get(row_idx, {})
        group = cell_text(row, "B")
        if group:
            current_group = group
        model_name = cell_text(row, "E")
        msrp = cell_number(row, "F")
        if not model_name or msrp is None:
            continue
        series = group_to_series.get(current_group or "", "CT5_")
        energy_type = "new_energy" if ("新能源" in model_name or series == "傲歌") else "fuel"
        models.append(
            {
                "brand": "Cadillac",
                "series": series,
                "model": model_name,
                "msrp": msrp,
                "energyType": energy_type,
                "loanMinimums": series_mins.get(series, {}),
            }
        )

    regular_fuel_terms = {
        60: {"contractRate": cell_number(factor_rows[2], "B"), "brandCoefficient": cell_number(factor_rows[4], "D")},
        48: {"contractRate": cell_number(factor_rows[2], "B"), "brandCoefficient": cell_number(factor_rows[5], "D")},
        36: {"contractRate": cell_number(factor_rows[2], "B"), "brandCoefficient": cell_number(factor_rows[6], "D")},
        24: {"contractRate": cell_number(factor_rows[2], "B"), "brandCoefficient": cell_number(factor_rows[7], "D")},
    }
    regular_energy_terms = {
        60: {"contractRate": cell_number(factor_rows[2], "G"), "brandCoefficient": cell_number(factor_rows[4], "I")},
        48: {"contractRate": cell_number(factor_rows[2], "G"), "brandCoefficient": cell_number(factor_rows[5], "I")},
        36: {"contractRate": cell_number(factor_rows[2], "G"), "brandCoefficient": cell_number(factor_rows[6], "I")},
        24: {"contractRate": cell_number(factor_rows[2], "G"), "brandCoefficient": cell_number(factor_rows[7], "I")},
    }
    zero_down_terms = {
        24: {"contractRate": cell_number(factor_rows[19], "B"), "brandCoefficient": cell_number(factor_rows[20], "D")},
        12: {"contractRate": cell_number(factor_rows[19], "B"), "brandCoefficient": cell_number(factor_rows[21], "D")},
    }
    fixed_plans = {
        "12万定额": {"term": 12, "fixedLoanAmount": 120000, "contractRate": cell_number(factor_rows[2], "B"), "brandAmount": cell_number(factor_rows[15], "D")},
        "10万定额": {"term": 24, "fixedLoanAmount": 100000, "contractRate": cell_number(factor_rows[2], "B"), "brandAmount": cell_number(factor_rows[16], "D")},
        "8万定额": {"term": 24, "fixedLoanAmount": 80000, "contractRate": cell_number(factor_rows[2], "B"), "brandAmount": cell_number(factor_rows[17], "D")},
    }
    smart_balloon = {
        0.2: {"term": 36, "contractRate": cell_number(factor_rows[2], "B"), "brandCoefficient": cell_number(factor_rows[10], "D"), "balloonRatio": 0.3},
        0.3: {"term": 36, "contractRate": cell_number(factor_rows[2], "B"), "brandCoefficient": cell_number(factor_rows[11], "D"), "balloonRatio": 0.3},
    }
    dual_advantage = {
        "contractRate": 0.116,
        "brandCoefficient": cell_number(factor_rows[12], "D"),
        "term": 60,
    }
    dual_non_factory = [
        {"planName": "双优贷2.0 / 非贴息", "planKey": "dual-advantage-2-non-factory", "contractRate": 0.116, "dealerSubsidySupported": True},
        {"planName": "双优贷1.0 / 非贴息", "planKey": "dual-advantage-1-non-factory", "contractRate": 0.097, "dealerSubsidySupported": True},
    ]
    generic_rates = [0.0798, 0.0898, 0.099, 0.109]

    for model in models:
        series = model["series"]
        minima = model["loanMinimums"]
        common_base = {
            "brand": "Cadillac",
            "model": model["model"],
            "series": series,
            "msrp": model["msrp"],
            "energyType": model["energyType"],
        }

        if series == "傲歌":
            for term, term_cfg in regular_energy_terms.items():
                offers.append(
                    {
                        **common_base,
                        "applicationType": "personal",
                        "planKey": "factory-regular-new-energy",
                        "planName": "厂贴低首付低利率",
                        "planCategory": "equal_installment",
                        "term": term,
                        "contractAnnualRate": term_cfg["contractRate"],
                        "brandSubsidyRule": {"type": "coefficient", "value": term_cfg["brandCoefficient"]},
                        "minDownPaymentRatio": 0.15,
                        "loanAmountMin": minima.get(term, 30000),
                        "loanAmountMax": None,
                        "fixedLoanAmount": None,
                        "dealerSubsidySupported": False,
                        "loanInputMode": "loan_amount",
                        "balloonRule": None,
                        "stagedPrincipalRule": None,
                        "systemKeyword": None,
                        "fiscalSupported": term in {24, 36, 48, 60},
                    }
                )
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": "factory-5050-new-energy",
                    "planName": "厂贴5050智慧式",
                    "planCategory": "balloon_5050",
                    "term": 12,
                    "contractAnnualRate": cell_number(factor_rows[2], "G"),
                    "brandSubsidyRule": {"type": "coefficient", "value": cell_number(factor_rows[9], "I")},
                    "minDownPaymentRatio": 0.5,
                    "loanAmountMin": None,
                    "loanAmountMax": None,
                    "fixedLoanAmount": None,
                    "dealerSubsidySupported": False,
                    "loanInputMode": "computed_50_percent",
                    "balloonRule": {"type": "ratio_of_total", "value": 0.5},
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )
            continue

        regular_plan_key = "factory-regular-new-ct6" if series == "新CT6" else "factory-regular-fuel"
        for term, term_cfg in regular_fuel_terms.items():
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": regular_plan_key,
                    "planName": "厂贴低首付低利率",
                    "planCategory": "equal_installment",
                    "term": term,
                    "contractAnnualRate": term_cfg["contractRate"],
                    "brandSubsidyRule": {"type": "coefficient", "value": term_cfg["brandCoefficient"]},
                    "minDownPaymentRatio": 0.2,
                    "loanAmountMin": minima.get(term, 30000),
                    "loanAmountMax": None,
                    "fixedLoanAmount": None,
                    "dealerSubsidySupported": False,
                    "loanInputMode": "loan_amount",
                    "balloonRule": None,
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )

        if series == "新CT6":
            fixed = fixed_plans["10万定额"]
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": "factory-fixed-100k",
                    "planName": "定额超低利率",
                    "planCategory": "equal_installment",
                    "term": fixed["term"],
                    "contractAnnualRate": fixed["contractRate"],
                    "brandSubsidyRule": {"type": "fixed_amount", "value": fixed["brandAmount"]},
                    "minDownPaymentRatio": 0.2,
                    "loanAmountMin": fixed["fixedLoanAmount"],
                    "loanAmountMax": fixed["fixedLoanAmount"],
                    "fixedLoanAmount": fixed["fixedLoanAmount"],
                    "dealerSubsidySupported": False,
                    "loanInputMode": "fixed_loan_amount",
                    "balloonRule": None,
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )
        else:
            for fixed_key in ("12万定额", "8万定额"):
                fixed = fixed_plans[fixed_key]
                offers.append(
                    {
                        **common_base,
                        "applicationType": "personal",
                        "planKey": plan_key("factory", fixed_key),
                        "planName": "定额超低利率",
                        "planCategory": "equal_installment",
                        "term": fixed["term"],
                        "contractAnnualRate": fixed["contractRate"],
                        "brandSubsidyRule": {"type": "fixed_amount", "value": fixed["brandAmount"]},
                        "minDownPaymentRatio": 0.2,
                        "loanAmountMin": fixed["fixedLoanAmount"],
                        "loanAmountMax": fixed["fixedLoanAmount"],
                        "fixedLoanAmount": fixed["fixedLoanAmount"],
                        "dealerSubsidySupported": False,
                        "loanInputMode": "fixed_loan_amount",
                        "balloonRule": None,
                        "stagedPrincipalRule": None,
                        "systemKeyword": None,
                        "fiscalSupported": True,
                    }
                )

        offers.append(
            {
                **common_base,
                "applicationType": "personal",
                "planKey": "factory-5050",
                "planName": "半付半贷 5050智慧贷",
                "planCategory": "balloon_5050",
                "term": 12,
                "contractAnnualRate": cell_number(factor_rows[2], "B"),
                "brandSubsidyRule": {"type": "coefficient", "value": cell_number(factor_rows[9], "D")},
                "minDownPaymentRatio": 0.5,
                "loanAmountMin": None,
                "loanAmountMax": None,
                "fixedLoanAmount": None,
                "dealerSubsidySupported": False,
                "loanInputMode": "computed_50_percent",
                "balloonRule": {"type": "ratio_of_total", "value": 0.5},
                "stagedPrincipalRule": None,
                "systemKeyword": None,
                "fiscalSupported": True,
            }
        )
        offers.append(
            {
                **common_base,
                "applicationType": "personal",
                "planKey": "factory-smart-balloon",
                "planName": "留尾款享更低月供",
                "planCategory": "balloon_smart",
                "term": 36,
                "contractAnnualRate": cell_number(factor_rows[2], "B"),
                "brandSubsidyRule": {"type": "coefficient_by_down_ratio", "values": {str(k): v["brandCoefficient"] for k, v in smart_balloon.items()}},
                "minDownPaymentRatio": 0.2,
                "loanAmountMin": None,
                "loanAmountMax": None,
                "fixedLoanAmount": None,
                "dealerSubsidySupported": False,
                "loanInputMode": "computed_down_ratio",
                "balloonRule": {"type": "ratio_of_total", "value": 0.3},
                "allowedDownPaymentRatios": [0.2, 0.3],
                "stagedPrincipalRule": None,
                "systemKeyword": None,
                "fiscalSupported": True,
            }
        )
        for term, term_cfg in zero_down_terms.items():
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": "factory-zero-down",
                    "planName": "0首付超低利率",
                    "planCategory": "equal_installment",
                    "term": term,
                    "contractAnnualRate": term_cfg["contractRate"],
                    "brandSubsidyRule": {"type": "coefficient", "value": term_cfg["brandCoefficient"]},
                    "minDownPaymentRatio": 0.0,
                    "maxDownPaymentRatio": 0.1999,
                    "loanAmountMin": None,
                    "loanAmountMax": None,
                    "fixedLoanAmount": None,
                    "dealerSubsidySupported": False,
                    "loanInputMode": "loan_amount",
                    "balloonRule": None,
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )

        if series not in {"傲歌"}:
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": "factory-dual-advantage-2",
                    "planName": "双优贷2.0",
                    "planCategory": "dual_advantage_2",
                    "term": dual_advantage["term"],
                    "contractAnnualRate": dual_advantage["contractRate"],
                    "brandSubsidyRule": {"type": "coefficient", "value": dual_advantage["brandCoefficient"]},
                    "minDownPaymentRatio": 0.2,
                    "loanAmountMin": 50000,
                    "loanAmountMax": None,
                    "fixedLoanAmount": None,
                    "dealerSubsidySupported": False,
                    "loanInputMode": "loan_amount",
                    "balloonRule": None,
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )
            first_year_ratio = 0.036 if series == "新CT6" else 0.0448
            subsidy_amount = 7850.220664356 if series == "新CT6" else 6254.8
            fixed_loan = 100000 if series == "新CT6" else 80000
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": "factory-step-1-plus-4",
                    "planName": "首年0息 1+4阶梯贷",
                    "planCategory": "step_1_plus_4",
                    "term": 60,
                    "contractAnnualRate": 0.0798,
                    "brandSubsidyRule": {"type": "fixed_amount", "value": subsidy_amount},
                    "minDownPaymentRatio": 0.2,
                    "loanAmountMin": fixed_loan,
                    "loanAmountMax": fixed_loan,
                    "fixedLoanAmount": fixed_loan,
                    "dealerSubsidySupported": False,
                    "loanInputMode": "fixed_loan_amount",
                    "balloonRule": None,
                    "stagedPrincipalRule": {"type": "first_year_principal_ratio", "value": first_year_ratio},
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )

        for rate in generic_rates:
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": plan_key("non-factory-equal", str(rate)),
                    "planName": f"非厂贴等额本息 {rate * 100:.2f}%",
                    "planCategory": "equal_installment",
                    "termOptions": [12, 18, 24, 36, 48, 60] if rate != 0.0798 else [60],
                    "term": None,
                    "contractAnnualRate": rate,
                    "brandSubsidyRule": {"type": "none", "value": 0},
                    "minDownPaymentRatio": 0.2 if model["energyType"] == "fuel" else 0.15,
                    "loanAmountMin": 50000,
                    "loanAmountMax": None,
                    "fixedLoanAmount": None,
                    "dealerSubsidySupported": False,
                    "loanInputMode": "loan_amount",
                    "balloonRule": None,
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )
        for offer in dual_non_factory:
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": offer["planKey"],
                    "planName": offer["planName"],
                    "planCategory": "dual_advantage_2" if "2.0" in offer["planName"] else "dual_advantage_1",
                    "term": 60,
                    "contractAnnualRate": offer["contractRate"],
                    "brandSubsidyRule": {"type": "none", "value": 0},
                    "minDownPaymentRatio": 0.2 if model["energyType"] == "fuel" else 0.15,
                    "loanAmountMin": 50000,
                    "loanAmountMax": None,
                    "fixedLoanAmount": None,
                    "dealerSubsidySupported": True,
                    "loanInputMode": "loan_amount",
                    "balloonRule": None,
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )

    fixtures.append(
        build_fixture(
            name="Cadillac 常规贴息 燃油车 60期",
            brand="Cadillac",
            application_type="personal",
            plan_key="factory-regular-fuel",
            category="equal_installment",
            term=60,
            inputs={
                "model": wb.value("厂贴_常规贴息（燃油车）", "B4"),
                "vehiclePrice": wb.value("厂贴_常规贴息（燃油车）", "B6"),
                "addOnAmount": wb.value("厂贴_常规贴息（燃油车）", "B7"),
                "loanAmount": wb.value("厂贴_常规贴息（燃油车）", "B9"),
            },
            expected={
                "payment": wb.value("厂贴_常规贴息（燃油车）", "C16"),
                "totalInterest": wb.value("厂贴_常规贴息（燃油车）", "D16"),
                "effectiveAnnualRate": wb.value("厂贴_常规贴息（燃油车）", "E16"),
                "brandSubsidyAmount": wb.value("厂贴_常规贴息（燃油车）", "H16"),
            },
        )
    )
    fixtures.append(
        build_fixture(
            name="Cadillac 双优贷2.0 60期",
            brand="Cadillac",
            application_type="personal",
            plan_key="factory-dual-advantage-2",
            category="dual_advantage_2",
            term=60,
            inputs={
                "model": text_or_none(wb.value("厂贴_双优贷2.0", "B4")),
                "vehiclePrice": wb.value("厂贴_双优贷2.0", "B6"),
                "addOnAmount": wb.value("厂贴_双优贷2.0", "B7"),
                "loanAmount": wb.value("厂贴_双优贷2.0", "B9"),
            },
            expected={
                "payment": wb.value("厂贴_双优贷2.0", "C16"),
                "totalInterest": wb.value("厂贴_双优贷2.0", "D16"),
                "effectiveAnnualRate": wb.value("厂贴_双优贷2.0", "E16"),
                "brandSubsidyAmount": wb.value("厂贴_双优贷2.0", "H16"),
            },
        )
    )
    fixtures.append(
        build_fixture(
            name="Cadillac 1+4 阶梯贷",
            brand="Cadillac",
            application_type="personal",
            plan_key="factory-step-1-plus-4",
            category="step_1_plus_4",
            term=60,
            inputs={
                "model": wb.value("厂贴_1+4阶梯贷", "B4"),
                "vehiclePrice": wb.value("厂贴_1+4阶梯贷", "B6"),
                "loanAmount": wb.value("厂贴_1+4阶梯贷", "B9"),
            },
            expected={
                "phaseOnePayment": wb.value("厂贴_1+4阶梯贷", "C16"),
                "phaseTwoPayment": wb.value("厂贴_1+4阶梯贷", "C17"),
                "brandSubsidyAmount": wb.value("厂贴_1+4阶梯贷", "I16"),
            },
        )
    )

    return {"offers": offers, "fixtures": fixtures}


def parse_buick(wb: Workbook) -> dict[str, Any]:
    model_rows = wb.rows("厂贴车型明细&贷款金额说明")
    rate_rows = wb.rows("参数-车系车型 利率")
    offers: list[dict[str, Any]] = []
    fixtures: list[dict[str, Any]] = []

    models: list[dict[str, Any]] = []
    current_series = None
    for row_idx in range(8, 120):
        row = model_rows.get(row_idx, {})
        series = cell_text(row, "B")
        if series:
            current_series = series
        model_name = cell_text(row, "C")
        msrp = cell_number(row, "D")
        if not model_name or msrp is None:
            continue
        energy_type = "new_energy" if "新能源" in model_name else "fuel"
        models.append(
            {
                "brand": "Buick",
                "series": current_series or "Unknown",
                "model": model_name,
                "msrp": msrp,
                "energyType": energy_type,
                "subsidyCap": cell_number(row, "E") or 0,
                "loanMinimums": {
                    12: cell_number(row, "F"),
                    18: cell_number(row, "G"),
                    24: cell_number(row, "H"),
                    36: cell_number(row, "I"),
                    48: cell_number(row, "J"),
                    60: cell_number(row, "K"),
                },
                "stepFixedLoan": cell_number(row, "L"),
                "dual2MinLoan": cell_number(row, "M"),
                "dual1MinLoan": cell_number(row, "N"),
                "min5050Total": cell_number(row, "O"),
                "fixed6666Loan": cell_number(row, "P"),
            }
        )

    rate_map: dict[str, dict[str, Any]] = {}
    for row_idx in range(19, 120):
        row = rate_rows.get(row_idx, {})
        model_name = cell_text(row, "B")
        if not model_name:
            continue
        rate_map[model_name] = {
            "regular": {
                60: cell_number(row, "C"),
                48: cell_number(row, "D"),
                36: cell_number(row, "E"),
                24: cell_number(row, "F"),
                18: cell_number(row, "G"),
                12: cell_number(row, "H"),
            },
            "rate5050": cell_number(row, "I"),
            "rate6666": cell_number(row, "J"),
            "fixed6666Loan": cell_number(row, "K"),
            "brand6666Amount": cell_number(row, "L"),
            "dual2Rate": cell_number(row, "N"),
            "dual1Rate": cell_number(row, "O"),
            "stepRate": cell_number(row, "P"),
            "stepFixedLoan": cell_number(row, "Q"),
            "stepBrandAmount": cell_number(row, "R"),
            "stepFirstYearPrincipalRatio": cell_number(row, "S"),
            "stepContractRate": cell_number(row, "T"),
        }

    personal_coefficients = {60: 0.15971, 48: 0.1270855, 36: 0.09503309, 24: 0.063589, 18: 0.048093750641866, 12: 0.032745}
    default_personal_min_down = {
        "至境世家": 0.15,
        "全新GL8 陆尊 新能源": 0.15,
        "GL8 陆尊 PHEV": 0.15,
        "25款世纪": 0.15,
        "至境L7": 0.15,
        "微蓝6_450KM": 0.2,
    }

    for model in models:
        rates = rate_map.get(model["model"])
        if not rates:
            continue

        common_base = {
            "brand": "Buick",
            "model": model["model"],
            "series": model["series"],
            "msrp": model["msrp"],
            "energyType": model["energyType"],
            "subsidyCap": model["subsidyCap"],
        }

        min_down = default_personal_min_down.get(model["series"], 0.2 if model["energyType"] == "fuel" else 0.15)
        regular_terms = [term for term, rate in rates["regular"].items() if rate and term != 12]
        if model["series"] == "25款世纪":
            regular_terms.append(12)

        for term in regular_terms:
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": "factory-regular-personal",
                    "planName": "厂贴低首付低利率",
                    "planCategory": "equal_installment",
                    "term": term,
                    "contractAnnualRate": rates["regular"][term],
                    "brandSubsidyRule": {
                        "type": "min_cap_and_vehicle_loan_coefficient",
                        "coefficient": personal_coefficients.get(term),
                        "capField": "subsidyCap",
                    },
                    "minDownPaymentRatio": min_down,
                    "loanAmountMin": model["loanMinimums"].get(term),
                    "loanAmountMax": None,
                    "fixedLoanAmount": None,
                    "dealerSubsidySupported": True,
                    "loanInputMode": "vehicle_and_addon_loan",
                    "loanBasis": "vehicle_plus_addon",
                    "addOnFinanceAllowed": True,
                    "balloonRule": None,
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )
            offers.append(
                {
                    **common_base,
                    "applicationType": "public",
                    "planKey": "factory-regular-public",
                    "planName": "厂贴低首付低利率（公户）",
                    "planCategory": "equal_installment",
                    "term": term,
                    "contractAnnualRate": rates["regular"][term],
                    "brandSubsidyRule": {
                        "type": "min_cap_and_vehicle_loan_coefficient",
                        "coefficient": personal_coefficients.get(term),
                        "capField": "subsidyCap",
                    },
                    "minDownPaymentRatio": 0.25 if model["energyType"] == "new_energy" else 0.3,
                    "loanAmountMin": model["loanMinimums"].get(term),
                    "loanAmountMax": None,
                    "fixedLoanAmount": None,
                    "dealerSubsidySupported": True,
                    "loanInputMode": "vehicle_and_addon_loan",
                    "loanBasis": "vehicle_plus_addon",
                    "addOnFinanceAllowed": True,
                    "balloonRule": None,
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )

        if rates["rate5050"] and model["min5050Total"]:
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": "factory-5050",
                    "planName": "5050智慧式",
                    "planCategory": "balloon_5050",
                    "term": 12,
                    "contractAnnualRate": rates["rate5050"],
                    "brandSubsidyRule": {"type": "fixed_amount", "value": model["subsidyCap"]},
                    "minDownPaymentRatio": 0.5,
                    "loanAmountMin": None,
                    "loanAmountMax": None,
                    "fixedLoanAmount": None,
                    "dealerSubsidySupported": False,
                    "loanInputMode": "computed_50_percent",
                    "loanBasis": "fifty_percent_total",
                    "minimumTotalPrice": model["min5050Total"],
                    "balloonRule": {"type": "ratio_of_total", "value": 0.5},
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )

        if rates["rate6666"] and rates["fixed6666Loan"] and rates["brand6666Amount"]:
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": "factory-6666",
                    "planName": "6666分段式",
                    "planCategory": "staged_6666",
                    "term": 24,
                    "contractAnnualRate": rates["rate6666"],
                    "brandSubsidyRule": {"type": "fixed_amount", "value": rates["brand6666Amount"]},
                    "minDownPaymentRatio": 0.2,
                    "loanAmountMin": rates["fixed6666Loan"],
                    "loanAmountMax": rates["fixed6666Loan"],
                    "fixedLoanAmount": rates["fixed6666Loan"],
                    "dealerSubsidySupported": False,
                    "loanInputMode": "fixed_loan_amount",
                    "loanBasis": "fixed_total",
                    "balloonRule": None,
                    "stagedPrincipalRule": {"type": "fixed_quarterly_principal", "ratios": [0.25, 0.25, 0.25, 0.25], "monthsBetween": 6},
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )

        if rates["dual2Rate"] and model["dual2MinLoan"]:
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": "factory-dual-advantage-2",
                    "planName": "双优贷2.0",
                    "planCategory": "dual_advantage_2",
                    "term": 60,
                    "contractAnnualRate": rates["dual2Rate"],
                    "brandSubsidyRule": {"type": "fixed_amount", "value": model["subsidyCap"]},
                    "minDownPaymentRatio": min_down,
                    "loanAmountMin": model["dual2MinLoan"],
                    "loanAmountMax": None,
                    "fixedLoanAmount": None,
                    "dealerSubsidySupported": False,
                    "loanInputMode": "loan_amount",
                    "loanBasis": "loan_amount",
                    "balloonRule": None,
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )
        if rates["dual1Rate"] and model["dual1MinLoan"]:
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": "factory-dual-advantage-1",
                    "planName": "双优贷1.0",
                    "planCategory": "dual_advantage_1",
                    "term": 60,
                    "contractAnnualRate": rates["dual1Rate"],
                    "brandSubsidyRule": {"type": "fixed_amount", "value": model["subsidyCap"]},
                    "minDownPaymentRatio": min_down,
                    "loanAmountMin": model["dual1MinLoan"],
                    "loanAmountMax": None,
                    "fixedLoanAmount": None,
                    "dealerSubsidySupported": False,
                    "loanInputMode": "loan_amount",
                    "loanBasis": "loan_amount",
                    "balloonRule": None,
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )
        if rates["stepRate"] and rates["stepFixedLoan"] and rates["stepBrandAmount"]:
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": "factory-step-1-plus-4",
                    "planName": "1+4阶梯贷",
                    "planCategory": "step_1_plus_4",
                    "term": 60,
                    "contractAnnualRate": rates["stepContractRate"] or rates["stepRate"],
                    "brandSubsidyRule": {"type": "fixed_amount", "value": rates["stepBrandAmount"]},
                    "minDownPaymentRatio": 0.2,
                    "loanAmountMin": rates["stepFixedLoan"],
                    "loanAmountMax": rates["stepFixedLoan"],
                    "fixedLoanAmount": rates["stepFixedLoan"],
                    "dealerSubsidySupported": False,
                    "loanInputMode": "fixed_loan_amount",
                    "loanBasis": "fixed_total",
                    "balloonRule": None,
                    "stagedPrincipalRule": {"type": "first_year_principal_ratio", "value": rates["stepFirstYearPrincipalRatio"]},
                    "systemKeyword": None,
                    "fiscalSupported": False,
                }
            )

        # Generic non-factory offers.
        for rate in (0.0798, 0.0898, 0.099, 0.109):
            term_options = [60] if rate == 0.0798 else [12, 18, 24, 36, 48, 60]
            offers.append(
                {
                    **common_base,
                    "applicationType": "personal",
                    "planKey": plan_key("non-factory-equal", str(rate)),
                    "planName": f"非厂贴等额本息 {rate * 100:.2f}%",
                    "planCategory": "equal_installment",
                    "term": None,
                    "termOptions": term_options,
                    "contractAnnualRate": rate,
                    "brandSubsidyRule": {"type": "none", "value": 0},
                    "minDownPaymentRatio": min_down,
                    "loanAmountMin": 50000,
                    "loanAmountMax": None,
                    "fixedLoanAmount": None,
                    "dealerSubsidySupported": False,
                    "loanInputMode": "loan_amount",
                    "loanBasis": "loan_amount",
                    "balloonRule": None,
                    "stagedPrincipalRule": None,
                    "systemKeyword": None,
                    "fiscalSupported": True,
                }
            )
            if rate in {0.0898, 0.099, 0.109}:
                offers.append(
                    {
                        **common_base,
                        "applicationType": "personal",
                        "planKey": plan_key("non-factory-5050", str(rate)),
                        "planName": f"非厂贴5050 {rate * 100:.2f}%",
                        "planCategory": "balloon_5050",
                        "term": 12,
                        "contractAnnualRate": rate,
                        "brandSubsidyRule": {"type": "none", "value": 0},
                        "minDownPaymentRatio": 0.5,
                        "loanAmountMin": None,
                        "loanAmountMax": None,
                        "fixedLoanAmount": None,
                        "dealerSubsidySupported": rate in {0.0898, 0.099, 0.109},
                        "loanInputMode": "computed_50_percent",
                        "loanBasis": "fifty_percent_total",
                        "balloonRule": {"type": "ratio_of_total", "value": 0.5},
                        "stagedPrincipalRule": None,
                        "systemKeyword": None,
                        "fiscalSupported": True,
                    }
                )
            if rate in {0.0898, 0.109}:
                offers.append(
                    {
                        **common_base,
                        "applicationType": "personal",
                        "planKey": plan_key("non-factory-smart", str(rate)),
                        "planName": f"非厂贴智慧贷 {rate * 100:.2f}%",
                        "planCategory": "balloon_smart",
                        "term": None,
                        "termOptions": [12, 18, 24, 36, 48, 60] if rate == 0.109 else [48, 60],
                        "contractAnnualRate": rate,
                        "brandSubsidyRule": {"type": "none", "value": 0},
                        "minDownPaymentRatio": min_down,
                        "loanAmountMin": 50000,
                        "loanAmountMax": None,
                        "fixedLoanAmount": None,
                        "dealerSubsidySupported": False,
                        "loanInputMode": "loan_amount",
                        "loanBasis": "loan_amount",
                        "balloonRule": {"type": "smart_rule"},
                        "stagedPrincipalRule": None,
                        "systemKeyword": None,
                        "fiscalSupported": False,
                    }
                )
            if rate == 0.0898:
                offers.append(
                    {
                        **common_base,
                        "applicationType": "personal",
                        "planKey": "non-factory-433",
                        "planName": "非厂贴433分段式",
                        "planCategory": "staged_433",
                        "term": 24,
                        "contractAnnualRate": rate,
                        "brandSubsidyRule": {"type": "none", "value": 0},
                        "minDownPaymentRatio": 0.4,
                        "loanAmountMin": None,
                        "loanAmountMax": None,
                        "fixedLoanAmount": None,
                        "dealerSubsidySupported": False,
                        "loanInputMode": "computed_60_percent_total",
                        "loanBasis": "sixty_percent_total",
                        "balloonRule": None,
                        "stagedPrincipalRule": {"type": "433"},
                        "systemKeyword": None,
                        "fiscalSupported": False,
                    }
                )
                offers.append(
                    {
                        **common_base,
                        "applicationType": "personal",
                        "planKey": "non-factory-x433",
                        "planName": "非厂贴X433分段式",
                        "planCategory": "staged_x433",
                        "term": 36,
                        "contractAnnualRate": rate,
                        "brandSubsidyRule": {"type": "none", "value": 0},
                        "minDownPaymentRatio": 0.2,
                        "loanAmountMin": 80000,
                        "loanAmountMax": None,
                        "fixedLoanAmount": None,
                        "dealerSubsidySupported": False,
                        "loanInputMode": "loan_amount",
                        "loanBasis": "loan_amount",
                        "balloonRule": None,
                        "stagedPrincipalRule": {"type": "x433"},
                        "systemKeyword": None,
                        "fiscalSupported": False,
                    }
                )

        offers.append(
            {
                **common_base,
                "applicationType": "personal",
                "planKey": "non-factory-dual-advantage-2",
                "planName": "非厂贴双优贷2.0",
                "planCategory": "dual_advantage_2",
                "term": 60,
                "contractAnnualRate": 0.116,
                "brandSubsidyRule": {"type": "none", "value": 0},
                "minDownPaymentRatio": min_down,
                "loanAmountMin": 50000,
                "loanAmountMax": None,
                "fixedLoanAmount": None,
                "dealerSubsidySupported": True,
                "loanInputMode": "loan_amount",
                "loanBasis": "loan_amount",
                "balloonRule": None,
                "stagedPrincipalRule": None,
                "systemKeyword": None,
                "fiscalSupported": True,
            }
        )
        offers.append(
            {
                **common_base,
                "applicationType": "personal",
                "planKey": "non-factory-dual-advantage-1",
                "planName": "非厂贴双优贷1.0",
                "planCategory": "dual_advantage_1",
                "term": 60,
                "contractAnnualRate": 0.097,
                "brandSubsidyRule": {"type": "none", "value": 0},
                "minDownPaymentRatio": min_down,
                "loanAmountMin": 50000,
                "loanAmountMax": None,
                "fixedLoanAmount": None,
                "dealerSubsidySupported": True,
                "loanInputMode": "loan_amount",
                "loanBasis": "loan_amount",
                "balloonRule": None,
                "stagedPrincipalRule": None,
                "systemKeyword": None,
                "fiscalSupported": False,
            }
        )

    fixtures.append(
        build_fixture(
            name="Buick 常规贴息 个人 60期",
            brand="Buick",
            application_type="personal",
            plan_key="factory-regular-personal",
            category="equal_installment",
            term=60,
            inputs={
                "model": text_or_none(wb.value("厂贴_常规贴息（个人）", "B4")),
                "vehiclePrice": wb.value("厂贴_常规贴息（个人）", "B6"),
                "vehicleLoanAmount": wb.value("厂贴_常规贴息（个人）", "B7"),
                "addOnAmount": wb.value("厂贴_常规贴息（个人）", "F3"),
                "addOnLoanAmount": wb.value("厂贴_常规贴息（个人）", "F4"),
                "dealerSubsidyAmount": wb.value("厂贴_常规贴息（个人）", "B9"),
            },
            expected={
                "payment": wb.value("厂贴_常规贴息（个人）", "C16"),
                "totalInterest": wb.value("厂贴_常规贴息（个人）", "D16"),
                "effectiveAnnualRate": wb.value("厂贴_常规贴息（个人）", "E16"),
                "brandSubsidyAmount": wb.value("厂贴_常规贴息（个人）", "H16"),
            },
        )
    )
    fixtures.append(
        build_fixture(
            name="Buick 5050 12期",
            brand="Buick",
            application_type="personal",
            plan_key="factory-5050",
            category="balloon_5050",
            term=12,
            inputs={
                "model": text_or_none(wb.value("厂贴_5050 6666", "B4")),
                "vehiclePrice": wb.value("厂贴_5050 6666", "B6"),
                "addOnAmount": wb.value("厂贴_5050 6666", "B7"),
            },
            expected={
                "payment": wb.value("厂贴_5050 6666", "C17"),
                "totalInterest": wb.value("厂贴_5050 6666", "D17"),
                "effectiveAnnualRate": wb.value("厂贴_5050 6666", "E17"),
                "brandSubsidyAmount": wb.value("厂贴_5050 6666", "H17"),
            },
        )
    )
    fixtures.append(
        build_fixture(
            name="Buick 6666 24期",
            brand="Buick",
            application_type="personal",
            plan_key="factory-6666",
            category="staged_6666",
            term=24,
            inputs={
                "model": "昂科威S 25T 白金版",
                "vehiclePrice": 196900,
                "addOnAmount": 0,
            },
            expected={
                "phaseOnePayment": 249,
                "totalInterest": 3735,
                "effectiveAnnualRate": 0.0332,
                "brandSubsidyAmount": 3003.75,
            },
        )
    )
    fixtures.append(
        build_fixture(
            name="Buick 双优贷2.0 60期",
            brand="Buick",
            application_type="personal",
            plan_key="factory-dual-advantage-2",
            category="dual_advantage_2",
            term=60,
            inputs={
                "model": text_or_none(wb.value("厂贴_双优贷2.0", "B4")),
                "vehiclePrice": wb.value("厂贴_双优贷2.0", "B6"),
                "addOnAmount": wb.value("厂贴_双优贷2.0", "B7"),
                "loanAmount": wb.value("厂贴_双优贷2.0", "B9"),
            },
            expected={
                "payment": wb.value("厂贴_双优贷2.0", "C18"),
                "totalInterest": wb.value("厂贴_双优贷2.0", "D18"),
                "effectiveAnnualRate": wb.value("厂贴_双优贷2.0", "E18"),
                "brandSubsidyAmount": wb.value("厂贴_双优贷2.0", "H18"),
            },
        )
    )

    return {"offers": offers, "fixtures": fixtures}


def parse_fiscal_policy(wb: Workbook) -> dict[str, Any]:
    policy_end = excel_serial_to_date(wb.value("财政贴息试算", "C3"))
    return {
        "maxAnnualRateSubsidy": wb.value("财政贴息试算", "C2"),
        "policyEndDate": policy_end,
        "singleQuoteCap": 3000,
        "eligibleApplicationTypes": ["personal"],
        "eligibleCategories": [
            "equal_installment",
            "balloon_5050",
            "staged_6666",
            "dual_advantage_1",
            "dual_advantage_2",
        ],
    }


def parse_fiscal_fixtures(wb: Workbook) -> list[dict[str, Any]]:
    return [
        build_fixture(
            name="财政贴息 等额本息",
            brand="FiscalPolicy",
            application_type="personal",
            plan_key="fiscal-equal",
            category="equal_installment",
            term=int(wb.value("财政贴息试算", "C9")),
            inputs={
                "principal": wb.value("财政贴息试算", "C8"),
                "annualRate": wb.value("财政贴息试算", "C10"),
                "disbursementDate": excel_serial_to_date(wb.value("财政贴息试算", "C11")),
            },
            expected={
                "subsidyTotal": wb.value("财政贴息试算", "C15"),
                "netAnnualFeeRate": wb.value("财政贴息试算", "C16"),
            },
        ),
        build_fixture(
            name="财政贴息 5050",
            brand="FiscalPolicy",
            application_type="personal",
            plan_key="fiscal-5050",
            category="balloon_5050",
            term=int(wb.value("财政贴息试算", "G9")),
            inputs={
                "principal": wb.value("财政贴息试算", "G8"),
                "annualRate": wb.value("财政贴息试算", "G10"),
                "disbursementDate": excel_serial_to_date(wb.value("财政贴息试算", "G11")),
                "balloonRatio": 0.5,
            },
            expected={
                "subsidyTotal": wb.value("财政贴息试算", "G15"),
                "netAnnualFeeRate": wb.value("财政贴息试算", "G16"),
            },
        ),
        build_fixture(
            name="财政贴息 6666",
            brand="FiscalPolicy",
            application_type="personal",
            plan_key="fiscal-6666",
            category="staged_6666",
            term=int(wb.value("财政贴息试算", "K9")),
            inputs={
                "principal": wb.value("财政贴息试算", "K8"),
                "annualRate": wb.value("财政贴息试算", "K10"),
                "disbursementDate": excel_serial_to_date(wb.value("财政贴息试算", "K11")),
            },
            expected={
                "subsidyTotal": wb.value("财政贴息试算", "K15"),
                "netAnnualFeeRate": wb.value("财政贴息试算", "K16"),
            },
        ),
    ]


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    cadillac_wb = Workbook(CADILLAC_FILE)
    buick_wb = Workbook(BUICK_FILE)
    fiscal_wb = Workbook(FISCAL_FILE)
    try:
        cadillac = parse_cadillac(cadillac_wb)
        buick = parse_buick(buick_wb)
        config = {
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "policy": parse_fiscal_policy(fiscal_wb),
            "offers": cadillac["offers"] + buick["offers"],
            "fixtures": cadillac["fixtures"] + buick["fixtures"] + parse_fiscal_fixtures(fiscal_wb),
        }
    finally:
        cadillac_wb.close()
        buick_wb.close()
        fiscal_wb.close()

    JSON_PATH.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    JS_PATH.write_text(
        "export const loanConfig = " + json.dumps(config, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    print(f"Wrote {JSON_PATH}")
    print(f"Wrote {JS_PATH}")


if __name__ == "__main__":
    main()
