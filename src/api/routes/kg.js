// ============================================================
// SOMA API — Knowledge Graph Routes
// GET    /kg/nodes
// GET    /kg/nodes/:id
// POST   /kg/nodes
// PATCH  /kg/nodes/:id
// POST   /kg/edges
// GET    /kg/search
// GET    /kg/paths
// ============================================================

const express = require('express');

module.exports = function kgRoutes(engine) {
  const router = express.Router();
  const kg = engine.kg;

  // GET /kg/nodes — query + paginate
  router.get('/kg/nodes', (req, res) => {
    try {
      const { type, tag, maturity, source, minConfidence, text, limit = 50, offset = 0 } = req.query;

      const filter = {};
      if (type) filter.type = type;
      if (tag) filter.tag = tag;
      if (maturity) filter.maturity = maturity;
      if (source) filter.source = source;
      if (minConfidence) filter.minConfidence = parseFloat(minConfidence);
      if (text) filter.text = text;

      const all = kg.query(filter);
      const total = all.length;
      const nodes = all.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

      res.json({ nodes, total, offset: parseInt(offset), limit: parseInt(limit) });
    } catch (err) {
      res.status(500).json({ error: { code: 'KG_QUERY_ERROR', message: err.message } });
    }
  });

  // GET /kg/nodes/:id — single node with neighbors and explanation
  router.get('/kg/nodes/:id', (req, res) => {
    try {
      const node = kg.getNode(req.params.id);
      if (!node) {
        return res.status(404).json({ error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.id} not found` } });
      }

      const neighbors = kg.neighbors(req.params.id, 'both');

      let explanation = null;
      try {
        explanation = engine.reasoner.explain(req.params.id);
      } catch (_) {}

      res.json({ node, neighbors, explanation });
    } catch (err) {
      res.status(500).json({ error: { code: 'NODE_GET_ERROR', message: err.message } });
    }
  });

  // POST /kg/nodes — add knowledge
  router.post('/kg/nodes', (req, res) => {
    try {
      const nodeData = req.body;
      if (!nodeData || typeof nodeData !== 'object') {
        return res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Node object required.' } });
      }

      // Attach userId from auth
      if (!nodeData.metadata) nodeData.metadata = {};
      if (req.auth?.userId) nodeData.metadata.addedBy = req.auth.userId;

      const node = engine.addKnowledge(nodeData);
      res.status(201).json({ node });
    } catch (err) {
      res.status(500).json({ error: { code: 'NODE_CREATE_ERROR', message: err.message } });
    }
  });

  // PATCH /kg/nodes/:id — update node fields
  router.patch('/kg/nodes/:id', (req, res) => {
    try {
      const existing = kg.getNode(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.id} not found` } });
      }

      const updated = kg.updateNode(req.params.id, req.body);
      res.json({ node: updated });
    } catch (err) {
      res.status(500).json({ error: { code: 'NODE_UPDATE_ERROR', message: err.message } });
    }
  });

  // POST /kg/edges — connect two nodes
  router.post('/kg/edges', (req, res) => {
    try {
      const { from, to, type = 'relates-to', weight = 1.0 } = req.body || {};

      if (!from || !to) {
        return res.status(400).json({ error: { code: 'MISSING_PARAMS', message: '"from" and "to" node IDs required.' } });
      }

      if (!kg.getNode(from)) {
        return res.status(404).json({ error: { code: 'NODE_NOT_FOUND', message: `Source node ${from} not found` } });
      }
      if (!kg.getNode(to)) {
        return res.status(404).json({ error: { code: 'NODE_NOT_FOUND', message: `Target node ${to} not found` } });
      }

      const edge = engine.connect(from, to, type, weight);
      if (!edge) {
        return res.status(400).json({ error: { code: 'EDGE_CREATE_FAILED', message: 'Failed to create edge — nodes may not exist.' } });
      }

      res.status(201).json({ edge });
    } catch (err) {
      res.status(500).json({ error: { code: 'EDGE_CREATE_ERROR', message: err.message } });
    }
  });

  // GET /kg/search — hybrid search
  router.get('/kg/search', (req, res) => {
    try {
      const { q, limit = 10 } = req.query;
      if (!q) {
        return res.status(400).json({ error: { code: 'MISSING_QUERY', message: '"q" query param required.' } });
      }

      const results = engine.hybridSearch(q, parseInt(limit));
      res.json({ results, query: q });
    } catch (err) {
      res.status(500).json({ error: { code: 'SEARCH_ERROR', message: err.message } });
    }
  });

  // GET /kg/paths?from=<id>&to=<id>&maxDepth=5
  router.get('/kg/paths', (req, res) => {
    try {
      const { from, to, maxDepth = 5 } = req.query;
      if (!from || !to) {
        return res.status(400).json({ error: { code: 'MISSING_PARAMS', message: '"from" and "to" node IDs required.' } });
      }

      const paths = kg.findPaths(from, to, parseInt(maxDepth));
      res.json({ paths, from, to, count: paths.length });
    } catch (err) {
      res.status(500).json({ error: { code: 'PATHS_ERROR', message: err.message } });
    }
  });

  return router;
};
