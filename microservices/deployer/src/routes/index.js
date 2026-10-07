/**
 * Route aggregator - mounts Cloud Run deploy under /api/v1
 */

const { Router } = require("express");
const cloudRunRoutes = require("./cloudRun");
const tenantRoutes = require("./tenants");

const router = Router();
router.use("/cloud-run", cloudRunRoutes);
router.use("/tenants", tenantRoutes);

module.exports = router;
