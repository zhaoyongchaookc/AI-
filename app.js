import { loanConfig } from "../data/loan-config.js";
import { getAvailableOptions, quoteLoan } from "./loan-engine.js";

const DEFAULT_COMPUTED_DOWN_PAYMENT_RATIO = 0.2;

const state = {
  brand: "",
  applicationType: "personal",
  model: "",
  planKey: "",
  term: "",
  vehiclePrice: "",
  purchaseTax: "0",
  insuranceAmount: "0",
  otherAddOnAmount: "0",
  addOnAmount: "0",
  addOnLoanAmount: "0",
  loanAmount: "",
  vehicleLoanAmount: "",
  disbursementDate: "",
  enableFiscalSubsidy: true,
};

const applicationLabels = {
  personal: "个人自用",
  public: "公户/企业",
};

const categoryLabels = {
  equal_installment: "等额本息",
  balloon_5050: "5050",
  balloon_smart: "智慧贷",
  staged_6666: "6666",
  staged_433: "433",
  staged_x433: "X433",
  dual_advantage_1: "双优贷1.0",
  dual_advantage_2: "双优贷2.0",
  step_1_plus_4: "1+4阶梯贷",
};

function uniquePayments(schedule) {
  return [...new Set(schedule.map((row) => Number(row.payment).toFixed(2)))].map(Number);
}

function describePaymentShape(result) {
  const schedule = result.schedule || [];
  if (schedule.length === 0) {
    return "-";
  }
  const distinctPayments = uniquePayments(schedule);
  const first = schedule[0];
  const last = schedule[schedule.length - 1];

  switch (result.planCategory) {
    case "equal_installment":
    case "dual_advantage_1":
    case "dual_advantage_2":
      return `等额本息，每期约 ${money(first.payment)}`;
    case "balloon_5050":
      return `前 ${result.term - 1} 期仅付息 ${money(first.payment)}，末期含尾款 ${money(last.payment)}`;
    case "balloon_smart":
      return `前 ${result.term - 1} 期月供约 ${money(first.payment)}，末期含尾款 ${money(last.payment)}`;
    case "staged_6666":
      return `分段式，共 ${distinctPayments.length} 档现金流，含 6 / 12 / 18 / 24 期大额还本`;
    case "staged_433":
    case "staged_x433":
      return `分段式，中途含阶段性还本，末期清尾款`;
    case "step_1_plus_4":
      return `1-12 期先还本金，13-60 期转等额本息`;
    default:
      return categoryLabels[result.planCategory] || result.planCategory;
  }
}

function byId(id) {
  return document.getElementById(id);
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function money(value) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 }).format(
    Number(value || 0),
  );
}

function percent(value, digits = 2) {
  return `${(Number(value || 0) * 100).toFixed(digits)}%`;
}

function setOptions(select, values, labelGetter = (value) => value) {
  const previous = select.value;
  select.innerHTML = "";
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = labelGetter(value);
    select.appendChild(option);
  });
  if (values.includes(previous)) {
    select.value = previous;
  } else if (values.length > 0) {
    select.value = values[0];
  }
}

function currentPlanGroup() {
  const options = getAvailableOptions(loanConfig, state);
  return options.plans.find((plan) => plan.planKey === state.planKey && plan.model === state.model);
}

function currentOffer() {
  const offers = loanConfig.offers.filter(
    (offer) =>
      offer.brand === state.brand &&
      offer.applicationType === state.applicationType &&
      offer.model === state.model &&
      offer.planKey === state.planKey,
  );
  return offers.find((offer) => String(offer.term) === String(state.term)) || offers[0];
}

function isVehicleAddonOffer(offer) {
  return offer?.loanInputMode === "vehicle_and_addon_loan";
}

function deriveAddonLineItems(offer) {
  const vehiclePrice = Number(byId("vehiclePrice")?.value || state.vehiclePrice || 0);
  const otherAddOnAmount = Number(byId("otherAddOnAmount")?.value || state.otherAddOnAmount || 0);
  const vatRate = 0.13;
  const purchaseTaxRate = 0.1;
  const purchaseTax =
    offer?.energyType === "new_energy"
      ? 0
      : roundMoney((vehiclePrice / (1 + vatRate)) * purchaseTaxRate);
  const insuranceAmount = roundMoney(vehiclePrice * 0.15);
  const addOnAmount = roundMoney(purchaseTax + insuranceAmount + otherAddOnAmount);
  return {
    purchaseTax,
    insuranceAmount,
    otherAddOnAmount,
    addOnAmount,
  };
}

function syncVehicleAddonLoanFieldsFromEvent(event) {
  const offer = currentOffer();
  if (!offer || !isVehicleAddonOffer(offer)) {
    return;
  }
  const tid = event.target?.id;
  if (tid === "vehicleLoanAmount" || tid === "addOnLoanAmount") {
    const v = roundMoney(byId("vehicleLoanAmount").value);
    const a = roundMoney(byId("addOnLoanAmount").value);
    byId("loanAmount").value = String(roundMoney(v + a));
  } else if (tid === "loanAmount") {
    const total = roundMoney(byId("loanAmount").value);
    const v = roundMoney(byId("vehicleLoanAmount").value);
    byId("addOnLoanAmount").value = String(roundMoney(Math.max(0, total - v)));
  }
}

function updateVehicleDownPaymentRatioDisplay() {
  const field = byId("vehicleDownPaymentRatio");
  if (!field) {
    return;
  }
  const vp = Number(byId("vehiclePrice").value || 0);
  const vl = Number(byId("vehicleLoanAmount").value || 0);
  if (vp <= 0) {
    field.value = "";
    return;
  }
  const ratio = Math.max(0, Math.min(1, 1 - vl / vp));
  field.value = String(Math.round((ratio + Number.EPSILON) * 10000) / 10000);
}

function syncFormState() {
  const options = getAvailableOptions(loanConfig, state);
  setOptions(byId("brand"), options.brands);
  state.brand = byId("brand").value;

  const appOptions = getAvailableOptions(loanConfig, { brand: state.brand }).applicationTypes;
  setOptions(byId("applicationType"), appOptions, (value) => applicationLabels[value] || value);
  if (!appOptions.includes(state.applicationType)) {
    state.applicationType = byId("applicationType").value;
  }

  const scoped = getAvailableOptions(loanConfig, { brand: state.brand, applicationType: state.applicationType });
  setOptions(byId("model"), scoped.models);
  state.model = byId("model").value;

  const modelPlans = getAvailableOptions(loanConfig, {
    brand: state.brand,
    applicationType: state.applicationType,
    model: state.model,
  }).plans;
  const planSelect = byId("planKey");
  planSelect.innerHTML = "";
  modelPlans.forEach((plan) => {
    const option = document.createElement("option");
    option.value = plan.planKey;
    option.textContent = `${plan.planName} · ${categoryLabels[plan.planCategory] || plan.planCategory}`;
    planSelect.appendChild(option);
  });
  if (!modelPlans.some((plan) => plan.planKey === state.planKey)) {
    state.planKey = planSelect.value;
  }
  planSelect.value = state.planKey;

  const plan = currentPlanGroup();
  const terms = (plan?.termOptions || []).map(String);
  setOptions(byId("term"), terms, (value) => `${value}期`);
  if (!terms.includes(String(state.term))) {
    state.term = byId("term").value;
  }
  byId("term").value = String(state.term);

  const offer = currentOffer();
  if (offer) {
    byId("vehiclePrice").value = state.vehiclePrice || offer.msrp;
    if (offer.loanInputMode === "fixed_loan_amount") {
      byId("loanAmount").value = offer.fixedLoanAmount;
    }
    const autoLoanModes = ["fixed_loan_amount", "computed_50_percent", "computed_60_percent_total", "computed_down_ratio"];
    const vehicleAddonMode = isVehicleAddonOffer(offer);
    const derivedLines = deriveAddonLineItems(offer);

    if (vehicleAddonMode) {
      state.purchaseTax = String(derivedLines.purchaseTax);
      state.insuranceAmount = String(derivedLines.insuranceAmount);
      state.addOnAmount = String(derivedLines.addOnAmount);
      byId("purchaseTax").value = state.purchaseTax;
      byId("insuranceAmount").value = state.insuranceAmount;
      byId("addOnAmount").value = state.addOnAmount;
      byId("purchaseTax").disabled = true;
      byId("insuranceAmount").disabled = true;
    } else {
      byId("purchaseTax").disabled = false;
      byId("insuranceAmount").disabled = false;
    }

    byId("loanAmount").disabled = autoLoanModes.includes(offer.loanInputMode);
    byId("vehicleLoanAmount").closest(".field").hidden = !vehicleAddonMode;
    byId("addOnLoanAmount").closest(".field").hidden = !offer.addOnFinanceAllowed;
    byId("addOnAmount").disabled = vehicleAddonMode;
    document.querySelectorAll(".addon-field").forEach((field) => {
      field.hidden = !vehicleAddonMode;
    });
    const vdpField = byId("vehicleDownPaymentRatioField");
    if (vdpField) {
      vdpField.hidden = !vehicleAddonMode;
    }
    updateVehicleDownPaymentRatioDisplay();
    byId("loanAmount").previousElementSibling.textContent =
      vehicleAddonMode ? "总贷款金额（车贷+附加贷，与下两项联动）" : "贷款金额";
    byId("addOnAmount").previousElementSibling.textContent = vehicleAddonMode ? "附加项合计" : "附加品金额";
    byId("addOnLoanAmount").previousElementSibling.textContent = "附加品贷款金额";
    byId("constraints").innerHTML = `
      <div>最低首付比例：${percent(offer.minDownPaymentRatio ?? 0, 0)}</div>
      <div>合同年化：${percent(offer.contractAnnualRate, 2)}</div>
      <div>财政贴息：${offer.fiscalSupported ? "可测算" : "当前方案不支持"}</div>
      ${vehicleAddonMode ? `<div>「车贷+附加贷」三项金额请手填；总贷款=车辆贷款+附加品贷款。购置税、保险按规则系统计算。车辆首付比例=1−车辆贷款÷开票价（用于贴息分档等）。</div>` : ""}
    `;
  }
}

function updateStateFromForm() {
  state.brand = byId("brand").value;
  state.applicationType = byId("applicationType").value;
  state.model = byId("model").value;
  state.planKey = byId("planKey").value;
  state.term = byId("term").value;
  state.vehiclePrice = byId("vehiclePrice").value;
  state.purchaseTax = byId("purchaseTax")?.value || "0";
  state.insuranceAmount = byId("insuranceAmount")?.value || "0";
  state.otherAddOnAmount = byId("otherAddOnAmount")?.value || "0";
  state.addOnAmount = byId("addOnAmount").value;
  state.addOnLoanAmount = byId("addOnLoanAmount").value;
  state.loanAmount = byId("loanAmount").value;
  state.vehicleLoanAmount = byId("vehicleLoanAmount").value;
  state.disbursementDate = byId("disbursementDate").value;
  state.enableFiscalSubsidy = byId("enableFiscalSubsidy").checked;
}

function renderSummary(result) {
  byId("summaryCards").innerHTML = `
    <article class="card metric">
      <span>合同年化</span>
      <strong>${percent(result.contractAnnualRate, 2)}</strong>
    </article>
    <article class="card metric">
      <span>客户实际年化</span>
      <strong>${percent(result.effectiveAnnualRate, 2)}</strong>
    </article>
    <article class="card metric">
      <span>品牌贴息</span>
      <strong>${money(result.brandSubsidyAmount)}</strong>
    </article>
    <article class="card metric">
      <span>财政贴息</span>
      <strong>${money(result.fiscalSubsidyAmount)}</strong>
    </article>
    <article class="card metric">
      <span>最终总支付</span>
      <strong>${money(result.customerNetPaymentAfterFiscal)}</strong>
    </article>
    <article class="card metric">
      <span>客户最终净利息</span>
      <strong>${money(result.finalNetInterest)}</strong>
    </article>
  `;

  const earlyRepayHtml =
    result.earlyRepaymentAt30 != null
      ? `
    <div class="quote-summary-early" role="region" aria-label="60期第30期末提前结清测算">
      <h3 class="quote-summary-early-title">60期·第30期末提前结清（测算）</h3>
      <p class="quote-summary-early-note">假设第30期月供正常归还后办理提前结清；满30期提前还款免违约金，违约金费率按 0 计。</p>
      <div><span>前30期累计应付利息（合同）</span><strong>${money(result.earlyRepaymentAt30.interestThrough30)}</strong></div>
      <div><span>前30期财政贴息累计（估算）</span><strong>${money(result.earlyRepaymentAt30.fiscalSubsidyThrough30)}</strong></div>
      <div><span>前30期客户净利息（合同利息−财政贴息）</span><strong>${money(result.earlyRepaymentAt30.netInterestThrough30)}</strong></div>
      <div><span>第30期后剩余本金（提前结清应还本金）</span><strong>${money(result.earlyRepaymentAt30.remainingPrincipalAfter30)}</strong></div>
      <div><span>提前还款违约金费率</span><strong>${percent(result.earlyRepaymentAt30.prepaymentFeeRate, 2)}</strong></div>
      <div><span>提前还款违约金金额（测算）</span><strong>${money(result.earlyRepaymentAt30.prepaymentFeeAmount)}</strong></div>
    </div>`
      : "";

  byId("quoteSummary").innerHTML = `
    <div><span>车型</span><strong>${result.offer.model}</strong></div>
    <div><span>申请主体</span><strong>${applicationLabels[result.offer.applicationType] || result.offer.applicationType}</strong></div>
    <div><span>方案</span><strong>${result.offer.planName}</strong></div>
    <div><span>期限</span><strong>${result.term} 期</strong></div>
    <div><span>总价</span><strong>${money(result.totalPrice)}</strong></div>
    <div><span>首付金额 / 比例</span><strong>${money(result.downPayment)} / ${percent(result.downPaymentRatio, 2)}</strong></div>
    <div><span>贷款本金</span><strong>${money(result.principal)}</strong></div>
    <div><span>月供形式</span><strong>${describePaymentShape(result)}</strong></div>
    <div><span>客户总支付</span><strong>${money(result.customerNetPaymentAfterFiscal)}</strong></div>
    ${earlyRepayHtml}
  `;

  const alerts = [];
  result.validation.forEach((message) => alerts.push({ type: "error", message }));
  if (!result.fiscal.enabled && result.fiscal.reason) {
    alerts.push({ type: "note", message: result.fiscal.reason });
  } else if (result.fiscal.enabled) {
    alerts.push({ type: "note", message: "财政贴息为估算值，单笔按 3000 元封顶，跨合同累计以最终审核为准。" });
  }
  byId("alerts").innerHTML = alerts
    .map((item) => `<div class="alert ${item.type}">${item.message}</div>`)
    .join("");
}

function renderSchedule(result) {
  const table = byId("scheduleTableBody");
  table.innerHTML = result.schedule
    .map(
      (row) => `
      <tr>
        <td>${row.label}</td>
        <td>${row.date || "-"}</td>
        <td>${money(row.payment)}</td>
        <td>${money(row.principal)}</td>
        <td>${money(row.interest)}</td>
        <td>${money(row.brandSubsidy)}</td>
        <td>${money(row.fiscalSubsidy)}</td>
        <td>${money(row.netPayment)}</td>
        <td>${money(row.endingBalance)}</td>
      </tr>`,
    )
    .join("");
}

function recalculate() {
  updateStateFromForm();
  syncFormState();
  const offer = currentOffer();
  const vehicleAddonMode = Boolean(offer && isVehicleAddonOffer(offer));
  const vehiclePrice = Number(byId("vehiclePrice").value || 0);
  const vehicleLoanAmt = Number(byId("vehicleLoanAmount").value || 0);
  let downRatioForEngine = DEFAULT_COMPUTED_DOWN_PAYMENT_RATIO;
  if (vehicleAddonMode && vehiclePrice > 0) {
    downRatioForEngine = Math.max(0, Math.min(1, 1 - vehicleLoanAmt / vehiclePrice));
  }
  const result = quoteLoan(loanConfig, {
    ...state,
    term: Number(state.term),
    vehiclePrice,
    addOnAmount: Number(byId("addOnAmount").value || 0),
    addOnLoanAmount: Number(byId("addOnLoanAmount").value || 0),
    loanAmount: Number(byId("loanAmount").value || 0),
    vehicleLoanAmount: vehicleLoanAmt,
    dealerSubsidyAmount: 0,
    downPaymentRatio: downRatioForEngine,
  });
  renderSummary(result);
  renderSchedule(result);
}

function mountFixtures() {
  const fixtureSelect = byId("fixture");
  fixtureSelect.innerHTML = `<option value="">载入 Excel 默认样例</option>`;
  loanConfig.fixtures
    .filter((fixture) => fixture.brand !== "FiscalPolicy")
    .forEach((fixture) => {
      const option = document.createElement("option");
      option.value = fixture.name;
      option.textContent = fixture.name;
      fixtureSelect.appendChild(option);
    });

  fixtureSelect.addEventListener("change", () => {
    const fixture = loanConfig.fixtures.find((item) => item.name === fixtureSelect.value);
    if (!fixture) {
      return;
    }
    state.brand = fixture.brand;
    state.applicationType = fixture.applicationType;
    state.model = fixture.inputs.model;
    state.planKey = fixture.planKey;
    state.term = String(fixture.term);
    state.vehiclePrice = String(fixture.inputs.vehiclePrice || 0);
    state.purchaseTax = "0";
    state.insuranceAmount = "0";
    state.otherAddOnAmount = "0";
    state.addOnAmount = String(fixture.inputs.addOnAmount || 0);
    state.addOnLoanAmount = String(fixture.inputs.addOnLoanAmount || 0);
    state.loanAmount = String(fixture.inputs.loanAmount || fixture.inputs.vehicleLoanAmount || 0);
    state.vehicleLoanAmount = String(fixture.inputs.vehicleLoanAmount || fixture.inputs.loanAmount || 0);
    syncFormState();
    byId("vehiclePrice").value = state.vehiclePrice;
    byId("otherAddOnAmount").value = state.otherAddOnAmount;
    byId("addOnAmount").value = state.addOnAmount;
    byId("addOnLoanAmount").value = state.addOnLoanAmount;
    byId("loanAmount").value = state.loanAmount;
    byId("vehicleLoanAmount").value = state.vehicleLoanAmount;
    const fo = currentOffer();
    if (fo && isVehicleAddonOffer(fo)) {
      const v = roundMoney(byId("vehicleLoanAmount").value);
      const a = roundMoney(byId("addOnLoanAmount").value);
      byId("loanAmount").value = String(roundMoney(v + a));
    }
    recalculate();
  });
}

function init() {
  const today = new Date().toISOString().slice(0, 10);
  state.disbursementDate = today;
  byId("disbursementDate").value = today;
  syncFormState();
  const form = document.querySelector("form");
  form.addEventListener("input", (e) => {
    syncVehicleAddonLoanFieldsFromEvent(e);
    updateVehicleDownPaymentRatioDisplay();
    recalculate();
  });
  form.addEventListener("change", (e) => {
    syncVehicleAddonLoanFieldsFromEvent(e);
    updateVehicleDownPaymentRatioDisplay();
    recalculate();
  });
  mountFixtures();
  recalculate();
}

init();
