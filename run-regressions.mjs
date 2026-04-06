import { loanConfig } from "../data/loan-config.js";
import { quoteLoan, quoteFiscalSubsidy } from "../src/loan-engine.js";

function assertClose(label, actual, expected, tolerance = 0.2) {
  if (Math.abs(Number(actual) - Number(expected)) > tolerance) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function runLoanFixtures() {
  const fixtures = loanConfig.fixtures.filter((fixture) => fixture.brand !== "FiscalPolicy");
  const failures = [];
  fixtures.forEach((fixture) => {
    try {
      const result = quoteLoan(loanConfig, {
        brand: fixture.brand,
        applicationType: fixture.applicationType,
        model: fixture.inputs.model,
        planKey: fixture.planKey,
        term: fixture.term,
        vehiclePrice: fixture.inputs.vehiclePrice || 0,
        addOnAmount: fixture.inputs.addOnAmount || 0,
        addOnLoanAmount: fixture.inputs.addOnLoanAmount || 0,
        loanAmount: fixture.inputs.loanAmount || fixture.inputs.vehicleLoanAmount || 0,
        vehicleLoanAmount: fixture.inputs.vehicleLoanAmount || fixture.inputs.loanAmount || 0,
        dealerSubsidyAmount: fixture.inputs.dealerSubsidyAmount || 0,
        disbursementDate: "2026-04-05",
        enableFiscalSubsidy: false,
      });

      if (fixture.expected.payment != null) {
        const firstPayment = result.schedule[0]?.payment;
        assertClose(`${fixture.name} payment`, firstPayment, fixture.expected.payment);
      }
      if (fixture.expected.phaseOnePayment != null) {
        assertClose(`${fixture.name} phaseOnePayment`, result.schedule[0]?.payment, fixture.expected.phaseOnePayment);
      }
      if (fixture.expected.phaseTwoPayment != null) {
        assertClose(`${fixture.name} phaseTwoPayment`, result.schedule[12]?.payment, fixture.expected.phaseTwoPayment);
      }
      if (fixture.expected.totalInterest != null) {
        assertClose(`${fixture.name} totalInterest`, result.customerTotalInterest, fixture.expected.totalInterest, 2);
      }
      if (fixture.expected.effectiveAnnualRate != null) {
        assertClose(`${fixture.name} rate`, result.effectiveAnnualRate, fixture.expected.effectiveAnnualRate, 0.002);
      }
      if (fixture.expected.brandSubsidyAmount != null) {
        assertClose(`${fixture.name} subsidy`, result.brandSubsidyAmount, fixture.expected.brandSubsidyAmount, 2);
      }
    } catch (error) {
      failures.push(error.message);
    }
  });
  return failures;
}

function runFiscalFixtures() {
  const fixtures = loanConfig.fixtures.filter((fixture) => fixture.brand === "FiscalPolicy");
  const failures = [];
  fixtures.forEach((fixture) => {
    try {
      const fakeRows = [];
      if (fixture.planCategory === "equal_installment") {
        const monthlyPayment =
          (fixture.inputs.principal *
            (fixture.inputs.annualRate / 12) *
            (1 + fixture.inputs.annualRate / 12) ** fixture.term) /
          ((1 + fixture.inputs.annualRate / 12) ** fixture.term - 1);
        let balance = fixture.inputs.principal;
        for (let month = 1; month <= fixture.term; month += 1) {
          const interest = balance * (fixture.inputs.annualRate / 12);
          const principal = monthlyPayment - interest;
          balance = Math.max(0, balance - principal);
          fakeRows.push({
            month,
            label: `${month}期`,
            date: null,
            payment: monthlyPayment,
            principal,
            interest,
            endingBalance: balance,
            brandSubsidy: 0,
            dealerSubsidy: 0,
            fiscalSubsidy: 0,
            netPayment: monthlyPayment,
          });
        }
      } else if (fixture.planCategory === "balloon_5050") {
        for (let month = 1; month <= fixture.term; month += 1) {
          const interest = fixture.inputs.principal * (fixture.inputs.annualRate / 12);
          fakeRows.push({
            month,
            label: `${month}期`,
            date: null,
            payment: month === fixture.term ? interest + fixture.inputs.principal : interest,
            principal: month === fixture.term ? fixture.inputs.principal : 0,
            interest,
            endingBalance: month === fixture.term ? 0 : fixture.inputs.principal,
            brandSubsidy: 0,
            dealerSubsidy: 0,
            fiscalSubsidy: 0,
            netPayment: month === fixture.term ? interest + fixture.inputs.principal : interest,
          });
        }
      } else {
        const balances = [1, 1, 1, 1, 1, 1, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25];
        for (let month = 1; month <= fixture.term; month += 1) {
          const ratio = balances[month - 1];
          const balance = fixture.inputs.principal * ratio;
          const principal =
            month === 6 || month === 12 || month === 18 || month === 24 ? fixture.inputs.principal * 0.25 : 0;
          const interest = balance * (fixture.inputs.annualRate / 12);
          fakeRows.push({
            month,
            label: `${month}期`,
            date: null,
            payment: interest + principal,
            principal,
            interest,
            endingBalance: Math.max(0, balance - principal),
            brandSubsidy: 0,
            dealerSubsidy: 0,
            fiscalSubsidy: 0,
            netPayment: interest + principal,
          });
        }
      }
      const result = quoteFiscalSubsidy(
        {
          schedule: fakeRows,
          effectiveAnnualRate: fixture.inputs.annualRate,
          isFiscalEligible: true,
          fiscalIneligibleReason: null,
          planCategory: fixture.planCategory,
        },
        {
          policy: loanConfig.policy,
          disbursementDate: fixture.inputs.disbursementDate,
        },
      );
      assertClose(`${fixture.name} subsidyTotal`, result.totalSubsidy, fixture.expected.subsidyTotal, 1.5);
      assertClose(`${fixture.name} netAnnualFeeRate`, result.netAnnualFeeRate, fixture.expected.netAnnualFeeRate, 0.01);
    } catch (error) {
      failures.push(error.message);
    }
  });
  return failures;
}

function runEligibilityChecks() {
  const failures = [];
  const fixture = loanConfig.fixtures.find((item) => item.name === "Buick 双优贷2.0 60期");
  if (!fixture) {
    failures.push("Missing eligibility fixture for Buick 双优贷2.0 60期");
    return failures;
  }
  try {
    const result = quoteLoan(loanConfig, {
      brand: fixture.brand,
      applicationType: fixture.applicationType,
      model: fixture.inputs.model,
      planKey: fixture.planKey,
      term: fixture.term,
      vehiclePrice: fixture.inputs.vehiclePrice || 0,
      addOnAmount: fixture.inputs.addOnAmount || 0,
      addOnLoanAmount: fixture.inputs.addOnLoanAmount || 0,
      loanAmount: fixture.inputs.loanAmount || fixture.inputs.vehicleLoanAmount || 0,
      vehicleLoanAmount: fixture.inputs.vehicleLoanAmount || fixture.inputs.loanAmount || 0,
      dealerSubsidyAmount: fixture.inputs.dealerSubsidyAmount || 0,
      disbursementDate: "2026-04-05",
      enableFiscalSubsidy: true,
    });
    if (!result.fiscal.enabled) {
      throw new Error(`Buick 双优贷2.0 60期 fiscal eligibility: expected enabled, got ${result.fiscal.reason}`);
    }
    if (!(Number(result.fiscalSubsidyAmount) > 0)) {
      throw new Error(`Buick 双优贷2.0 60期 fiscal subsidy: expected positive, got ${result.fiscalSubsidyAmount}`);
    }
  } catch (error) {
    failures.push(error.message);
  }
  return failures;
}

const failures = [...runLoanFixtures(), ...runFiscalFixtures(), ...runEligibilityChecks()];

if (failures.length > 0) {
  console.error("Regression failures:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Validated ${loanConfig.fixtures.length} fixtures successfully.`);
