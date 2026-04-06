function roundTo(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function roundUp2(value) {
  return Math.ceil((value - 1e-9) * 100) / 100;
}

function roundUp(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.ceil((value - 1e-9) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function positiveNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function monthlyPmt(annualRate, periods, principal, balloon = 0) {
  const r = annualRate / 12;
  if (Math.abs(r) < 1e-12) {
    return (principal - balloon) / periods;
  }
  const discount = 1 / (1 + r) ** periods;
  return (principal - balloon * discount) * (r / (1 - discount));
}

function rateFromPayment(payment, periods, principal, balloon = 0) {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    const guess = monthlyPmt(mid * 12, periods, principal, balloon);
    if (guess > payment) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return ((low + high) / 2) * 12;
}

function dateToIso(date) {
  return date.toISOString().slice(0, 10);
}

function addMonths(date, months) {
  const result = new Date(date.getTime());
  const day = result.getDate();
  result.setMonth(result.getMonth() + months);
  if (result.getDate() < day) {
    result.setDate(0);
  }
  return result;
}

function endOfPolicyWindow(startDate, monthIndex, endDate) {
  const periodStart = addMonths(startDate, monthIndex);
  const periodEnd = new Date(Math.min(addMonths(startDate, monthIndex + 1).getTime() - 86400000, endDate.getTime()));
  return { periodStart, periodEnd };
}

function diffDaysInclusive(startDate, endDate) {
  return Math.floor((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
}

function makeRow({
  month,
  label,
  date,
  payment,
  principal,
  interest,
  endingBalance,
  brandSubsidy = 0,
  dealerSubsidy = 0,
  fiscalSubsidy = 0,
}) {
  return {
    month,
    label,
    date,
    payment: roundTo(payment),
    principal: roundTo(principal),
    interest: roundTo(interest),
    brandSubsidy: roundTo(brandSubsidy),
    dealerSubsidy: roundTo(dealerSubsidy),
    fiscalSubsidy: roundTo(fiscalSubsidy),
    netPayment: roundTo(payment - brandSubsidy - dealerSubsidy - fiscalSubsidy),
    endingBalance: roundTo(Math.max(endingBalance, 0)),
  };
}

function allocateEvenly(total, count) {
  if (!total || count <= 0) {
    return Array.from({ length: count }, () => 0);
  }
  const base = roundTo(total / count, 10);
  const allocations = Array.from({ length: count }, () => base);
  const normalized = allocations.map((value) => roundTo(value));
  let delta = roundTo(total - normalized.reduce((sum, value) => sum + value, 0));
  let index = 0;
  while (Math.abs(delta) >= 0.01 && index < normalized.length + 5) {
    const target = normalized.length - 1 - (index % normalized.length);
    normalized[target] = roundTo(normalized[target] + Math.sign(delta) * 0.01);
    delta = roundTo(total - normalized.reduce((sum, value) => sum + value, 0));
    index += 1;
  }
  return normalized;
}

function withSubsidySplit(rows, totalBrandSubsidy, totalDealerSubsidy) {
  const totalSubsidy = totalBrandSubsidy + totalDealerSubsidy;
  if (rows.length === 0 || totalSubsidy <= 0) {
    return rows;
  }
  const ratio = totalSubsidy > 0 ? totalBrandSubsidy / totalSubsidy : 1;
  const totalPayments = rows.reduce((sum, row) => sum + row.payment, 0) || rows.length;
  const rawTotals = rows.map((row) => (row.payment / totalPayments) * totalSubsidy);
  const rowTotals = allocateEvenly(rawTotals.reduce((sum, value) => sum + value, 0), rows.length);
  return rows.map((row, index) => {
    const subtotal = rowTotals[index];
    const brandSubsidy = roundTo(subtotal * ratio);
    const dealerSubsidy = roundTo(subtotal - brandSubsidy);
    return {
      ...row,
      brandSubsidy,
      dealerSubsidy,
      netPayment: row.netPayment,
    };
  });
}

function buildEqualSchedule({
  principal,
  annualRate,
  term,
  payment,
  balloon = 0,
  startDate,
}) {
  const rate = annualRate / 12;
  let balance = principal;
  const rows = [];
  for (let month = 1; month <= term; month += 1) {
    const isFinal = month === term;
    const interest = balance * rate;
    const basePayment = isFinal ? payment + balloon : payment;
    const principalPayment = isFinal ? balance : basePayment - interest;
    balance = Math.max(0, balance - principalPayment);
    rows.push(
      makeRow({
        month,
        label: isFinal && balloon > 0 ? `${month}期（含尾款）` : `${month}期`,
        date: startDate ? dateToIso(addMonths(startDate, month - 1)) : null,
        payment: basePayment,
        principal: principalPayment,
        interest,
        endingBalance: balance,
      }),
    );
  }
  return rows;
}

function build5050Schedule({ principal, annualRate, term, startDate }) {
  const monthlyInterest = principal * (annualRate / 12);
  const payment = roundUp2(monthlyInterest);
  const rows = [];
  for (let month = 1; month <= term; month += 1) {
    const final = month === term;
    rows.push(
      makeRow({
        month,
        label: final ? `${month}期（含尾款）` : `${month}期`,
        date: startDate ? dateToIso(addMonths(startDate, month - 1)) : null,
        payment: final ? payment + principal : payment,
        principal: final ? principal : 0,
        interest: payment,
        endingBalance: final ? 0 : principal,
      }),
    );
  }
  return rows;
}

function smartBalloonRatio(term) {
  if (term >= 48) {
    return 0.2;
  }
  return 0.3;
}

function buildStaged6666Schedule({ principal, annualRate, startDate }) {
  const stages = [
    { months: [1, 2, 3, 4, 5], balanceRatio: 1, principalPayment: 0 },
    { months: [6], balanceRatio: 1, principalPayment: principal * 0.25 },
    { months: [7, 8, 9, 10, 11], balanceRatio: 0.75, principalPayment: 0 },
    { months: [12], balanceRatio: 0.75, principalPayment: principal * 0.25 },
    { months: [13, 14, 15, 16, 17], balanceRatio: 0.5, principalPayment: 0 },
    { months: [18], balanceRatio: 0.5, principalPayment: principal * 0.25 },
    { months: [19, 20, 21, 22, 23], balanceRatio: 0.25, principalPayment: 0 },
    { months: [24], balanceRatio: 0.25, principalPayment: principal * 0.25 },
  ];
  const rows = [];
  let endingBalance = principal;
  stages.forEach((stage) => {
    stage.months.forEach((month) => {
      const balance = principal * stage.balanceRatio;
      const interest = balance * (annualRate / 12);
      const payment = interest + stage.principalPayment;
      endingBalance = Math.max(0, balance - stage.principalPayment);
      rows.push(
        makeRow({
          month,
          label: `${month}期`,
          date: startDate ? dateToIso(addMonths(startDate, month - 1)) : null,
          payment,
          principal: stage.principalPayment,
          interest,
          endingBalance,
        }),
      );
    });
  });
  rows[0].label = "1-5期";
  rows[5].label = "6期";
  rows[6].label = "7-11期";
  rows[11].label = "12期";
  rows[12].label = "13-17期";
  rows[17].label = "18期";
  rows[18].label = "19-23期";
  rows[23].label = "24期（尾款）";
  return rows;
}

function buildStaged433Schedule({ principal, annualRate, startDate }) {
  const periodInterest = principal * (annualRate / 12);
  const month12Principal = principal * 0.5;
  const month24Principal = principal * 0.5;
  const rows = [];
  for (let month = 1; month <= 24; month += 1) {
    const balance = month <= 12 ? principal : principal * 0.5;
    const principalPayment = month === 12 ? month12Principal : month === 24 ? month24Principal : 0;
    const interest = balance * (annualRate / 12);
    const endingBalance = month < 12 ? principal : month < 24 ? principal * 0.5 : 0;
    rows.push(
      makeRow({
        month,
        label: `${month}期`,
        date: startDate ? dateToIso(addMonths(startDate, month - 1)) : null,
        payment: interest + principalPayment,
        principal: principalPayment,
        interest,
        endingBalance,
      }),
    );
  }
  rows[0].label = "1-11期";
  rows[11].label = "12期";
  rows[12].label = "13-23期";
  rows[23].label = "24期";
  return rows;
}

function buildStagedX433Schedule({ principal, annualRate, startDate }) {
  const plan = [
    { month: 12, amount: principal * 0.4 },
    { month: 24, amount: principal * 0.3 },
    { month: 36, amount: principal * 0.3 },
  ];
  const rows = [];
  let balance = principal;
  for (let month = 1; month <= 36; month += 1) {
    const event = plan.find((item) => item.month === month);
    const interest = balance * (annualRate / 12);
    const principalPayment = event ? event.amount : 0;
    balance = Math.max(0, balance - principalPayment);
    rows.push(
      makeRow({
        month,
        label: `${month}期`,
        date: startDate ? dateToIso(addMonths(startDate, month - 1)) : null,
        payment: interest + principalPayment,
        principal: principalPayment,
        interest,
        endingBalance: balance,
      }),
    );
  }
  rows[0].label = "1-11期";
  rows[11].label = "12期";
  rows[12].label = "13-23期";
  rows[23].label = "24期";
  rows[24].label = "25-35期";
  rows[35].label = "36期";
  return rows;
}

function buildStep14Schedule({
  principal,
  stageOnePrincipalRatio,
  stageTwoAnnualRate,
  startDate,
}) {
  const firstYearPrincipal = principal * stageOnePrincipalRatio;
  const firstPayment = roundUp2(firstYearPrincipal / 12);
  const stageOneRows = [];
  let stageOneBalance = principal;
  for (let month = 1; month <= 12; month += 1) {
    stageOneBalance = Math.max(0, stageOneBalance - firstPayment);
    stageOneRows.push(
      makeRow({
        month,
        label: month === 1 ? "1-12期" : `${month}期`,
        date: startDate ? dateToIso(addMonths(startDate, month - 1)) : null,
        payment: firstPayment,
        principal: firstPayment,
        interest: 0,
        endingBalance: stageOneBalance,
      }),
    );
  }
  const secondPayment = roundUp2(monthlyPmt(stageTwoAnnualRate, 48, stageOneBalance, 0));
  const stageTwoRows = buildEqualSchedule({
    principal: stageOneBalance,
    annualRate: stageTwoAnnualRate,
    term: 48,
    payment: secondPayment,
    startDate: startDate ? addMonths(startDate, 12) : null,
  }).map((row, index) => ({
    ...row,
    month: row.month + 12,
    label: index === 0 ? "13-60期" : row.label,
  }));
  return [...stageOneRows, ...stageTwoRows];
}

function computeFiscalSubsidy({ rows, policy, annualRate, startDate, category }) {
  if (!policy || !startDate || !annualRate || annualRate <= 0) {
    return { rows, totalSubsidy: 0, netAnnualFeeRate: null };
  }
  const start = new Date(startDate);
  const policyEnd = new Date(policy.policyEndDate);
  if (start > policyEnd) {
    return { rows, totalSubsidy: 0, netAnnualFeeRate: null };
  }
  const subsidyRate = Math.min(policy.maxAnnualRateSubsidy, annualRate);
  let accumulated = 0;
  const enriched = rows.map((row, index) => {
    if (accumulated >= policy.singleQuoteCap) {
      return { ...row, fiscalSubsidy: 0, netPayment: row.netPayment };
    }
    const { periodStart, periodEnd } = endOfPolicyWindow(start, index, policyEnd);
    if (periodStart > policyEnd) {
      return { ...row, fiscalSubsidy: 0, netPayment: row.netPayment };
    }
    const days = Math.min(30, diffDaysInclusive(periodStart, periodEnd));
    let basis = row.endingBalance + row.principal;
    if (category === "balloon_5050") {
      basis = row.month === rows.length ? row.principal : row.endingBalance;
    }
    const theoretical = basis * subsidyRate * (days / 360);
    const subsidy = roundTo(Math.min(theoretical, row.interest, policy.singleQuoteCap - accumulated));
    accumulated = roundTo(accumulated + subsidy);
    return {
      ...row,
      fiscalSubsidy: subsidy,
      netPayment: roundTo(row.netPayment - subsidy),
    };
  });
  const totalInterest = enriched.reduce((sum, row) => sum + row.interest, 0);
  const principal = enriched.reduce((sum, row) => sum + row.principal, 0);
  const years = rows.length / 12;
  const totalSubsidy = roundTo(accumulated);
  return {
    rows: enriched,
    totalSubsidy,
    netAnnualFeeRate: years > 0 ? roundTo((totalInterest - totalSubsidy) / principal / years, 6) : null,
  };
}

function applyFiscalFor6666(rows, policy, annualRate, startDate) {
  if (!policy || !startDate || !annualRate || annualRate <= 0) {
    return { rows, totalSubsidy: 0, netAnnualFeeRate: null };
  }
  const start = new Date(startDate);
  const policyEnd = new Date(policy.policyEndDate);
  if (start > policyEnd) {
    return { rows, totalSubsidy: 0, netAnnualFeeRate: null };
  }
  const subsidyRate = Math.min(policy.maxAnnualRateSubsidy, annualRate);
  let accumulated = 0;
  const enriched = rows.map((row, index) => {
    const { periodStart, periodEnd } = endOfPolicyWindow(start, index, policyEnd);
    if (periodStart > policyEnd || accumulated >= policy.singleQuoteCap) {
      return row;
    }
    const days = Math.min(30, diffDaysInclusive(periodStart, periodEnd));
    const basis = row.endingBalance + row.principal;
    const subsidy = roundTo(Math.min(basis * subsidyRate * (days / 360), row.interest, policy.singleQuoteCap - accumulated));
    accumulated = roundTo(accumulated + subsidy);
    return {
      ...row,
      fiscalSubsidy: subsidy,
      netPayment: roundTo(row.netPayment - subsidy),
    };
  });
  const totalInterest = enriched.reduce((sum, row) => sum + row.interest, 0);
  const principal = enriched.reduce((sum, row) => sum + row.principal, 0);
  const years = rows.length / 12;
  return {
    rows: enriched,
    totalSubsidy: roundTo(accumulated),
    netAnnualFeeRate: years > 0 ? roundTo((totalInterest - accumulated) / principal / years, 6) : null,
  };
}

export function getAvailableOptions(config, state = {}) {
  const offers = config.offers || [];
  const brands = [...new Set(offers.map((offer) => offer.brand))].sort();
  const brandOffers = state.brand ? offers.filter((offer) => offer.brand === state.brand) : offers;
  const applicationTypes = [...new Set(brandOffers.map((offer) => offer.applicationType))].sort();
  const scopedOffers = state.applicationType
    ? brandOffers.filter((offer) => offer.applicationType === state.applicationType)
    : brandOffers;
  const models = [...new Set(scopedOffers.map((offer) => offer.model))].sort((left, right) =>
    left.localeCompare(right, "zh-Hans-CN"),
  );
  const modelOffers = state.model ? scopedOffers.filter((offer) => offer.model === state.model) : scopedOffers;
  const planGroups = new Map();
  modelOffers.forEach((offer) => {
    const key = `${offer.applicationType}|${offer.model}|${offer.planKey}`;
    if (!planGroups.has(key)) {
      planGroups.set(key, {
        key,
        planKey: offer.planKey,
        planName: offer.planName,
        planCategory: offer.planCategory,
        model: offer.model,
        applicationType: offer.applicationType,
        termOptions: [],
      });
    }
    const group = planGroups.get(key);
    const terms = offer.term ? [offer.term] : offer.termOptions || [];
    terms.forEach((term) => {
      if (!group.termOptions.includes(term)) {
        group.termOptions.push(term);
      }
    });
    group.termOptions.sort((a, b) => a - b);
  });
  const plans = [...planGroups.values()].sort((left, right) => left.planName.localeCompare(right.planName, "zh-Hans-CN"));
  return { brands, applicationTypes, models, plans };
}

function quoteBaseInputs(offer, input) {
  const vehiclePrice = positiveNumber(input.vehiclePrice);
  const addOnAmount = positiveNumber(input.addOnAmount);
  let addOnLoanAmount = offer.addOnFinanceAllowed ? positiveNumber(input.addOnLoanAmount) : 0;
  const dealerSubsidyAmount = offer.dealerSubsidySupported ? positiveNumber(input.dealerSubsidyAmount) : 0;
  let loanAmount = positiveNumber(input.loanAmount);
  let vehicleLoanAmount = positiveNumber(input.vehicleLoanAmount || input.loanAmount);

  if (offer.loanInputMode === "fixed_loan_amount") {
    loanAmount = positiveNumber(offer.fixedLoanAmount);
    vehicleLoanAmount = loanAmount;
  }
  if (offer.loanInputMode === "computed_50_percent") {
    loanAmount = roundTo((vehiclePrice + addOnAmount) * 0.5);
    vehicleLoanAmount = loanAmount;
  }
  if (offer.loanInputMode === "computed_60_percent_total") {
    loanAmount = roundTo((vehiclePrice + addOnAmount) * 0.6);
    vehicleLoanAmount = loanAmount;
  }
  if (offer.loanInputMode === "computed_down_ratio") {
    const totalPrice = vehiclePrice + addOnAmount;
    const downRatio = positiveNumber(input.downPaymentRatio || 0.2);
    loanAmount = roundTo(totalPrice * (1 - downRatio));
    vehicleLoanAmount = loanAmount;
  }
  if (offer.loanInputMode === "vehicle_and_addon_loan") {
    vehicleLoanAmount = positiveNumber(input.vehicleLoanAmount);
    addOnLoanAmount = offer.addOnFinanceAllowed ? positiveNumber(input.addOnLoanAmount) : 0;
    loanAmount = roundTo(vehicleLoanAmount + addOnLoanAmount);
  }

  const totalPrice = vehiclePrice + addOnAmount;
  const principal =
    offer.loanBasis === "vehicle_plus_addon"
      ? vehicleLoanAmount + addOnLoanAmount
      : offer.loanBasis === "sixty_percent_total"
        ? loanAmount
        : loanAmount;
  const downPayment = roundTo(totalPrice - principal);
  const downPaymentRatio = totalPrice > 0 ? downPayment / totalPrice : 0;
  return {
    totalPrice,
    vehiclePrice,
    addOnAmount,
    addOnLoanAmount,
    loanAmount,
    vehicleLoanAmount,
    principal,
    downPayment,
    downPaymentRatio,
    dealerSubsidyAmount,
  };
}

function computeBrandSubsidy(offer, inputs) {
  const rule = offer.brandSubsidyRule || { type: "none", value: 0 };
  if (rule.type === "none") {
    return 0;
  }
  if (rule.type === "coefficient") {
    return roundTo(inputs.loanAmount * positiveNumber(rule.value));
  }
  if (rule.type === "fixed_amount") {
    return roundTo(positiveNumber(rule.value));
  }
  if (rule.type === "coefficient_by_down_ratio") {
    const values = rule.values || {};
    const key = String(inputs.downPaymentRatio || 0.2);
    const coefficient = positiveNumber(values[key] ?? values["0.2"] ?? 0);
    return roundTo(inputs.loanAmount * coefficient);
  }
  if (rule.type === "min_cap_and_vehicle_loan_coefficient") {
    const coefficient = positiveNumber(rule.coefficient);
    const cap = positiveNumber(inputs.subsidyCap);
    return roundTo(Math.min(cap, inputs.vehicleLoanAmount * coefficient));
  }
  return 0;
}

function buildPlanSchedule(offer, inputs, quoteDate) {
  const startDate = quoteDate ? new Date(quoteDate) : null;
  const brandSubsidyTotal = computeBrandSubsidy(offer, inputs);
  const dealerSubsidyTotal = inputs.dealerSubsidyAmount || 0;
  let rows = [];
  let contractAnnualRate = positiveNumber(offer.contractAnnualRate);
  let effectiveAnnualRate = contractAnnualRate;

  if (offer.planCategory === "equal_installment") {
    const term = offer.term || positiveNumber(inputs.term);
    const balloon = 0;
    const payment = roundUp2(monthlyPmt(contractAnnualRate, term, inputs.principal, balloon) - (brandSubsidyTotal + dealerSubsidyTotal) / term);
    effectiveAnnualRate = rateFromPayment(payment, term, inputs.principal, balloon);
    rows = buildEqualSchedule({
      principal: inputs.principal,
      annualRate: effectiveAnnualRate,
      term,
      payment,
      balloon,
      startDate,
    });
  } else if (offer.planCategory === "balloon_5050") {
    const term = offer.term || positiveNumber(inputs.term);
    const payment = roundUp2(monthlyPmt(contractAnnualRate, term, inputs.principal, inputs.principal) - (brandSubsidyTotal + dealerSubsidyTotal) / term);
    effectiveAnnualRate = rateFromPayment(payment, term, inputs.principal, inputs.principal);
    rows = buildEqualSchedule({
      principal: inputs.principal,
      annualRate: effectiveAnnualRate,
      term,
      payment,
      balloon: inputs.principal,
      startDate,
    });
  } else if (offer.planCategory === "balloon_smart") {
    const term = positiveNumber(inputs.term);
    const balloonRatio =
      offer.balloonRule?.value ?? (offer.balloonRule?.type === "smart_rule" ? smartBalloonRatio(term) : 0.3);
    const balloon = (inputs.totalPrice || inputs.vehiclePrice) * balloonRatio;
    const payment = roundUp2(monthlyPmt(contractAnnualRate, term, inputs.principal, balloon) - (brandSubsidyTotal + dealerSubsidyTotal) / term);
    effectiveAnnualRate = rateFromPayment(payment, term, inputs.principal, balloon);
    rows = buildEqualSchedule({
      principal: inputs.principal,
      annualRate: effectiveAnnualRate,
      term,
      payment,
      balloon,
      startDate,
    });
  } else if (offer.planCategory === "staged_6666") {
    effectiveAnnualRate = contractAnnualRate;
    rows = buildStaged6666Schedule({ principal: inputs.principal, annualRate: contractAnnualRate, startDate });
  } else if (offer.planCategory === "staged_433") {
    effectiveAnnualRate = contractAnnualRate;
    rows = buildStaged433Schedule({ principal: inputs.principal, annualRate: contractAnnualRate, startDate });
  } else if (offer.planCategory === "staged_x433") {
    effectiveAnnualRate = contractAnnualRate;
    rows = buildStagedX433Schedule({ principal: inputs.principal, annualRate: contractAnnualRate, startDate });
  } else if (offer.planCategory === "dual_advantage_1" || offer.planCategory === "dual_advantage_2") {
    const term = offer.term || 60;
    const hiddenPayment = roundUp2(
      monthlyPmt(contractAnnualRate, term, inputs.principal, 0) - (brandSubsidyTotal + dealerSubsidyTotal) / term,
    );
    effectiveAnnualRate = roundUp(rateFromPayment(hiddenPayment, term, inputs.principal, 0), 4);
    const payment = monthlyPmt(effectiveAnnualRate, term, inputs.principal, 0);
    rows = buildEqualSchedule({
      principal: inputs.principal,
      annualRate: effectiveAnnualRate,
      term,
      payment,
      balloon: 0,
      startDate,
    });
  } else if (offer.planCategory === "step_1_plus_4") {
    const firstYearRatio = positiveNumber(offer.stagedPrincipalRule?.value, 0.0448);
    rows = buildStep14Schedule({
      principal: inputs.principal,
      stageOnePrincipalRatio: firstYearRatio,
      stageTwoAnnualRate: positiveNumber(offer.contractAnnualRate),
      startDate,
    });
    const totalPaid = rows.reduce((sum, row) => sum + row.payment, 0);
    effectiveAnnualRate = rateFromPayment(totalPaid / rows.length, rows.length, inputs.principal, 0);
  } else {
    throw new Error(`Unsupported plan category: ${offer.planCategory}`);
  }

  const subsidizedRows =
    offer.planCategory === "step_1_plus_4"
      ? (() => {
          const brandAllocations = allocateEvenly(brandSubsidyTotal, rows.length);
          const dealerAllocations = allocateEvenly(dealerSubsidyTotal, rows.length);
          return rows.map((row, index) => ({
            ...row,
            brandSubsidy: brandAllocations[index],
            dealerSubsidy: dealerAllocations[index],
            netPayment: row.netPayment,
          }));
        })()
      : withSubsidySplit(rows, brandSubsidyTotal, dealerSubsidyTotal);

  return {
    rows: subsidizedRows,
    brandSubsidyTotal: roundTo(brandSubsidyTotal),
    dealerSubsidyTotal: roundTo(dealerSubsidyTotal),
    effectiveAnnualRate: roundTo(effectiveAnnualRate, 6),
    contractAnnualRate,
  };
}

function findOffer(config, selection) {
  const modelOffers = config.offers.filter(
    (offer) =>
      offer.brand === selection.brand &&
      offer.applicationType === selection.applicationType &&
      offer.model === selection.model &&
      offer.planKey === selection.planKey,
  );
  if (modelOffers.length === 0) {
    return null;
  }
  return modelOffers.find((offer) => offer.term === selection.term) || modelOffers[0];
}

export function quoteFiscalSubsidy(brandResult, policyInput) {
  if (!brandResult.isFiscalEligible) {
    return {
      enabled: false,
      reason: brandResult.fiscalIneligibleReason,
      totalSubsidy: 0,
      netAnnualFeeRate: null,
      rows: brandResult.schedule,
    };
  }
  if (brandResult.planCategory === "staged_6666") {
    const result = applyFiscalFor6666(
      brandResult.schedule,
      policyInput.policy,
      brandResult.effectiveAnnualRate,
      policyInput.disbursementDate,
    );
    return { enabled: true, reason: null, ...result };
  }
  const result = computeFiscalSubsidy({
    rows: brandResult.schedule,
    policy: policyInput.policy,
    annualRate: brandResult.effectiveAnnualRate,
    startDate: policyInput.disbursementDate,
    category: brandResult.planCategory,
  });
  return { enabled: true, reason: null, ...result };
}

export function quoteLoan(config, selection) {
  const offer = findOffer(config, selection);
  if (!offer) {
    throw new Error("未找到匹配的贷款方案。");
  }

  const baseInputs = quoteBaseInputs(offer, selection);
  const validation = [];
  if (baseInputs.totalPrice > offer.msrp * 1.15) {
    validation.push("总价超过市场指导价的 115%。");
  }
  if (offer.loanAmountMin && baseInputs.loanAmount < offer.loanAmountMin && offer.loanInputMode !== "vehicle_and_addon_loan") {
    validation.push(`贷款金额不得低于 ${offer.loanAmountMin.toFixed(0)} 元。`);
  }
  if (offer.loanInputMode === "vehicle_and_addon_loan") {
    if (offer.loanAmountMin && baseInputs.vehicleLoanAmount < offer.loanAmountMin) {
      validation.push(`车辆贷款金额不得低于 ${offer.loanAmountMin.toFixed(0)} 元。`);
    }
  }
  if (offer.minDownPaymentRatio != null && baseInputs.downPaymentRatio + 1e-9 < offer.minDownPaymentRatio) {
    validation.push(`首付比例不得低于 ${(offer.minDownPaymentRatio * 100).toFixed(0)}%。`);
  }
  if (offer.maxDownPaymentRatio != null && baseInputs.downPaymentRatio - 1e-9 > offer.maxDownPaymentRatio) {
    validation.push(`首付比例不得高于 ${(offer.maxDownPaymentRatio * 100).toFixed(2)}%。`);
  }
  if (offer.minimumTotalPrice && baseInputs.totalPrice + 1e-9 < offer.minimumTotalPrice) {
    validation.push(`总价不得低于 ${offer.minimumTotalPrice.toFixed(0)} 元。`);
  }

  const planInputs = {
    ...baseInputs,
    subsidyCap: positiveNumber(offer.subsidyCap || 0),
    downPaymentRatio: Number.isFinite(Number(selection.downPaymentRatio))
      ? positiveNumber(selection.downPaymentRatio)
      : baseInputs.downPaymentRatio,
    term: selection.term || offer.term,
  };
  const planResult = buildPlanSchedule(offer, planInputs, selection.disbursementDate);
  let totalPayment = roundTo(planResult.rows.reduce((sum, row) => sum + row.payment, 0));
  let totalInterest = roundTo(planResult.rows.reduce((sum, row) => sum + row.interest, 0));
  const totalPrincipal = roundTo(planResult.rows.reduce((sum, row) => sum + row.principal, 0));
  let totalNetPaymentBeforeFiscal = roundTo(planResult.rows.reduce((sum, row) => sum + row.netPayment, 0));

  if (offer.planCategory === "dual_advantage_1" || offer.planCategory === "dual_advantage_2") {
    totalPayment = roundTo(monthlyPmt(planResult.effectiveAnnualRate, selection.term || offer.term || 60, planInputs.principal, 0) * (selection.term || offer.term || 60));
    totalInterest = roundTo(totalPayment - planInputs.principal);
    totalNetPaymentBeforeFiscal = totalPayment;
  }

  const isFiscalEligible =
    selection.enableFiscalSubsidy === true &&
    offer.applicationType === "personal" &&
    offer.fiscalSupported === true &&
    planResult.effectiveAnnualRate > 0 &&
    !!selection.disbursementDate;

  const fiscalIneligibleReason =
    selection.enableFiscalSubsidy !== true
      ? "未启用财政贴息测算。"
      : offer.applicationType !== "personal"
        ? "财政贴息仅支持个人客户。"
        : offer.fiscalSupported !== true
          ? "该贷款结构当前不纳入财政贴息测算。"
          : !selection.disbursementDate
            ? "请先选择预计放款日期。"
            : planResult.effectiveAnnualRate <= 0
              ? "客户实际承担利率不大于 0，不能继续财政贴息。"
              : null;

  const fiscal = quoteFiscalSubsidy(
    {
      schedule: planResult.rows,
      effectiveAnnualRate: planResult.effectiveAnnualRate,
      isFiscalEligible,
      fiscalIneligibleReason,
      planCategory: offer.planCategory,
    },
    { policy: config.policy, disbursementDate: selection.disbursementDate },
  );

  const finalSchedule = fiscal.enabled ? fiscal.rows : planResult.rows;
  const fiscalTotal = roundTo(fiscal.totalSubsidy || 0);
  const finalNetPayment = roundTo(finalSchedule.reduce((sum, row) => sum + row.netPayment, 0));

  const termNum = Number(selection.term || offer.term);
  let earlyRepaymentAt30 = null;
  if (termNum === 60 && finalSchedule.length >= 30) {
    const first30 = finalSchedule.slice(0, 30);
    const interestThrough30 = roundTo(first30.reduce((sum, row) => sum + row.interest, 0));
    const fiscalSubsidyThrough30 = roundTo(first30.reduce((sum, row) => sum + row.fiscalSubsidy, 0));
    earlyRepaymentAt30 = {
      interestThrough30,
      fiscalSubsidyThrough30,
      netInterestThrough30: roundTo(interestThrough30 - fiscalSubsidyThrough30),
      remainingPrincipalAfter30: roundTo(first30[29].endingBalance),
      prepaymentFeeRate: 0,
      prepaymentFeeAmount: 0,
    };
  }

  return {
    offer,
    validation,
    totalPrice: roundTo(baseInputs.totalPrice),
    downPayment: roundTo(baseInputs.downPayment),
    downPaymentRatio: roundTo(baseInputs.downPaymentRatio, 4),
    loanAmount: roundTo(baseInputs.loanAmount),
    vehicleLoanAmount: roundTo(baseInputs.vehicleLoanAmount),
    addOnLoanAmount: roundTo(baseInputs.addOnLoanAmount),
    principal: roundTo(baseInputs.principal),
    contractAnnualRate: roundTo(planResult.contractAnnualRate, 6),
    effectiveAnnualRate: roundTo(planResult.effectiveAnnualRate, 6),
    brandSubsidyAmount: roundTo(planResult.brandSubsidyTotal),
    dealerSubsidyAmount: roundTo(planResult.dealerSubsidyTotal),
    fiscalSubsidyAmount: fiscalTotal,
    totalContractPayment: totalPayment,
    customerTotalInterest: totalInterest,
    totalPrincipal,
    customerTotalPaymentBeforeFiscal: totalNetPaymentBeforeFiscal,
    customerNetPaymentAfterFiscal: finalNetPayment,
    finalNetInterest: roundTo(totalInterest - fiscalTotal),
    planCategory: offer.planCategory,
    term: selection.term || offer.term,
    schedule: finalSchedule,
    fiscal,
    earlyRepaymentAt30,
  };
}
