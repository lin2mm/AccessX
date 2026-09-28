"""Offline planning calculator; all inputs are assumptions, not supplier quotes.
No network or application imports. USD, one prepaid B2B hardware batch.
Export supplier, importing reseller and end-buyer costs are separate.
Usage: python partner-order-economics.py [--input INPUT.csv] [--output OUTPUT.csv]
Without --input, writes illustrative inputs and results beside this file.
"""
import argparse
import csv
import math
from pathlib import Path
BASE = Path(__file__).resolve().parent
DEFAULT = dict(scenario='bundle_standard', units=50, net_price=139,
    lock_export_cost=50, keypad_cost=18, gateway_cost=22, gateways_per_lock=1,
    other_variable=11, support_minutes=15, support_hourly=30,
    supplier_paid_platform_monthly=0, endbuyer_platform_monthly=6, months=12,
    setup_cost=300, deposit_fraction=.5, retail_price=179,
    reseller_freight_import_cost=10, reseller_support=5,
    reseller_payment=4, reseller_warranty=3, buyer_setup_labor=10)
FIELDS = list(DEFAULT)

def calculate(raw):
    d={k:float(raw[k]) for k in FIELDS if k!='scenario'}
    if any(not math.isfinite(v) or v<0 for v in d.values()):
        raise ValueError('All numeric inputs must be finite and nonnegative')
    if d['units']<=0 or d['units']!=int(d['units']) or d['months']<=0:
        raise ValueError('Positive integer units and positive months required')
    if not 0<=d['deposit_fraction']<=1 or not 0<=d['gateways_per_lock']<=1:
        raise ValueError('Deposit and gateways-per-lock must be within 0..1')
    n=int(d['units'])
    # Whole gateway count, not a fractional unit discount.
    gateways=math.ceil(n*d['gateways_per_lock'])
    hardware=n*(d['lock_export_cost']+d['keypad_cost'])+gateways*d['gateway_cost']
    support=d['support_minutes']*d['support_hourly']/60
    variable=n*(d['other_variable']+support+d['supplier_paid_platform_monthly']*d['months'])
    sales=n*d['net_price']
    contribution=(sales-hardware-variable)/n
    net=sales-hardware-variable-d['setup_cost']
    reseller_unit=d['retail_price']-d['net_price']-sum(d[k] for k in
        ['reseller_freight_import_cost','reseller_support','reseller_payment','reseller_warranty'])
    buyer_tco=d['retail_price']+d['buyer_setup_labor']+d['endbuyer_platform_monthly']*d['months']
    cash=0.; low=0.
    # Setup first, deposit cleared, full hardware supplier payment, cleared balance,
    # then provision ALL modeled variable costs including service horizon.
    for event in [-d['setup_cost'],sales*d['deposit_fraction'],-hardware,
                  sales*(1-d['deposit_fraction']),-variable]:
        cash+=event;low=min(low,cash)
    assert math.isclose(cash,net,abs_tol=1e-7)
    return dict(scenario=raw['scenario'],units=n,gateway_count=gateways,
        supplier_unit_cost=(hardware+variable)/n,supplier_unit_contribution=contribution,
        supplier_batch_surplus_before_corporate_fixed=net,
        supplier_batch_bridge_cash=-low,
        # Approximation uses this batch's gateway allocation, not a future-order guarantee.
        approximate_setup_recovery_units=math.ceil(d['setup_cost']/contribution) if contribution>0 else 'never',
        reseller_unit_contribution=reseller_unit,reseller_batch_contribution=reseller_unit*n,
        buyer_first_year_cost_per_door=buyer_tco,
        review='economic_candidate_only' if net>=0 and reseller_unit>0 else 'reprice_or_reduce_scope')

def scenarios():
    return [DEFAULT.copy(),dict(DEFAULT,scenario='bundle_at_old_bare_price',net_price=89),
        dict(DEFAULT,scenario='bundle_custom_integration',setup_cost=2400),
        dict(DEFAULT,scenario='bundle_shared_gateway',gateways_per_lock=.2),
        dict(DEFAULT,scenario='bundle_supplier_funds_platform',supplier_paid_platform_monthly=6,endbuyer_platform_monthly=0),
        dict(DEFAULT,scenario='bundle_high_support',support_minutes=60),
        dict(DEFAULT,scenario='bundle_20_units',units=20)]

def write_csv(path,rows):
    with Path(path).open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader()
        for row in rows:
            w.writerow({k:round(v,2) if isinstance(v,float) else v for k,v in row.items()})

def selftest():
    b=calculate(DEFAULT)
    assert b['supplier_unit_contribution']==30.5
    assert b['supplier_batch_surplus_before_corporate_fixed']==1225
    assert b['supplier_batch_bridge_cash']==1325
    assert b['buyer_first_year_cost_per_door']==261
    assert calculate(dict(DEFAULT,net_price=89))['approximate_setup_recovery_units']=='never'
    assert calculate(dict(DEFAULT,units=3,gateways_per_lock=.2))['gateway_count']==1
    for change in [dict(units=0),dict(units=1.5),dict(net_price=float('nan')),dict(deposit_fraction=2)]:
        try: calculate(dict(DEFAULT,**change))
        except ValueError: pass
        else: raise AssertionError(change)
    print('PASS: reconciliation, known cases, gateway rounding and invalid inputs.')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path)
    parser.add_argument('--output',type=Path,default=BASE/'partner-order-economics-results.csv')
    args=parser.parse_args();selftest()
    if args.input:
        with args.input.open() as f: rows=list(csv.DictReader(f))
        if not rows: raise ValueError('Input requires at least one scenario')
    else:
        rows=scenarios();write_csv(BASE/'partner-order-economics-inputs.csv',rows)
    results=[calculate(row) for row in rows];write_csv(args.output,results)
    for row in results: print(row)
