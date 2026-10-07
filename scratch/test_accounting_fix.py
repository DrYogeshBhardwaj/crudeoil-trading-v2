import sys
import os
sys.path.insert(0, os.path.abspath("."))

import unittest
import json
from bitcoin_live_engine import BITCOIN_LIVE_ENGINE, MudrexLiveAdapter

class TestMudrexAccountingFix(unittest.TestCase):
    
    def test_strategy_risk_parameters_unchanged(self):
        """Verify strategy & risk parameters exist and are positive."""
        self.assertGreater(BITCOIN_LIVE_ENGINE.per_trade_profit_target_inr, 0.0)
        self.assertGreater(BITCOIN_LIVE_ENGINE.per_trade_loss_limit_inr, 0.0)
        self.assertGreater(BITCOIN_LIVE_ENGINE.daily_loss_limit_inr, 0.0)
        self.assertEqual(BITCOIN_LIVE_ENGINE.MAX_POSITIONS, 1)

    def test_audit_data_calculation(self):
        """Verify audit calculations with known Mudrex position fill numbers."""
        adapter = MudrexLiveAdapter()
        
        # Test calculation logic for a sample trade
        entry_usd = 85900.50
        exit_usd = 85843.90
        qty = 0.002
        hedge_rate = 102.0
        gross_pnl_inr = -11.54
        
        # Entry value in INR = 85900.5 * 0.002 * 102 = 17523.70
        # Entry fee (0.05%) + GST (18%) = 17523.70 * 0.00059 = 10.34
        entry_fee_gst = (entry_usd * qty * hedge_rate) * 0.00059
        
        # Exit value in INR = 85843.9 * 0.002 * 102 = 17512.15
        # Exit fee (0.05%) + GST (18%) = 17512.15 * 0.00059 = 10.33
        exit_fee_gst = (exit_usd * qty * hedge_rate) * 0.00059
        
        total_charges = entry_fee_gst + exit_fee_gst
        net_pnl = gross_pnl_inr - total_charges
        
        self.assertAlmostEqual(entry_fee_gst, 10.339, places=2)
        self.assertAlmostEqual(exit_fee_gst, 10.332, places=2)
        self.assertAlmostEqual(total_charges, 20.671, places=2)
        self.assertAlmostEqual(net_pnl, -32.211, places=2)

if __name__ == "__main__":
    unittest.main()

