// ============================================================
// SOMA — Entry Point
// Boot the engine, run the loop, expose the API.
// ============================================================

const SomaEngine = require('./engine');

async function boot(options = {}) {
  const engine = new SomaEngine({
    verbose: options.verbose ?? true,
    ...options
  });

  await engine.initialize();

  // Print boot report
  const state = engine.self.currentState();
  const who = engine.whoAmI();

  console.log('\n════════════════════════════════════════════');
  console.log('  SOMA ENGINE');
  console.log('════════════════════════════════════════════');
  console.log(`  Identity:    ${who.identity}`);
  console.log(`  Nature:      ${who.nature}`);
  console.log(`  Knowledge:   ${state.knowledge.nodes || 0} nodes, ${state.knowledge.edges || 0} edges`);
  console.log(`  Confidence:  ${(state.confidence || 0).toFixed(2)}`);
  console.log(`  State:       ${state.mood}`);
  console.log(`  LLM tool:    ${state.tools.llmAvailable ? 'available' : 'unavailable (using composer)'}`);
  console.log(`  Tools:       ${state.tools.available?.join(', ') || 'none'}`);

  if (state.activeGaps.length > 0) {
    console.log(`\n  Gaps:`);
    for (const gap of state.activeGaps) {
      console.log(`    - ${gap}`);
    }
  }

  console.log('════════════════════════════════════════════\n');

  return engine;
}

// ── Autonomous Loop ───────────────────────────────────────────

async function runLoop(engine, intervalMs = 300000) {
  console.log(`[Soma] Autonomous loop started (interval: ${intervalMs / 1000}s)`);

  const tick = async () => {
    try {
      const cycle = await engine.reflect();
      const action = cycle.phases?.act;

      if (action?.action !== 'self-maintain' || action?.output !== 'No maintenance needed.') {
        console.log(`[Soma] Cycle ${cycle.id}: ${action?.action} (${action?.source}) — ${cycle.elapsed}ms`);
        if (action?.output) {
          console.log(`  ${action.output.split('\n')[0].slice(0, 100)}`);
        }
      }
    } catch (err) {
      console.error(`[Soma] Cycle error: ${err.message}`);
    }
  };

  // Run immediately, then on interval
  await tick();
  return setInterval(tick, intervalMs);
}

// ── CLI Interface ─────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const engine = await boot({ verbose: true });

  switch (command) {
    case 'query':
    case 'ask': {
      const query = args.slice(1).join(' ');
      if (!query) {
        console.log('Usage: node index.js query "your question"');
        break;
      }
      const result = await engine.query(query);
      console.log('\n' + (result.phases?.act?.output || 'No response generated.'));
      break;
    }

    case 'reflect': {
      const result = await engine.reflect();
      console.log('\n' + (result.phases?.act?.output || 'No insights.'));
      break;
    }

    case 'status': {
      const status = engine.status();
      console.log(JSON.stringify(status, null, 2));
      break;
    }

    case 'who': {
      const who = engine.whoAmI();
      console.log(JSON.stringify(who, null, 2));
      break;
    }

    case 'patterns': {
      const analysis = engine.patterns.analyze();
      const report = engine.composer.composePatternReport({
        ...analysis,
        windowDays: 30
      });
      console.log('\n' + report);
      break;
    }

    case 'insights': {
      const insights = engine.reasoner.generateInsights();
      if (insights.length === 0) {
        console.log('No insights at this time.');
      } else {
        for (const insight of insights) {
          console.log(`\n[${insight.priority}] ${insight.type}: ${insight.content}`);
          if (insight.suggestion) console.log(`  → ${insight.suggestion}`);
        }
      }
      break;
    }

    case 'loop': {
      const interval = parseInt(args[1]) || 300000;
      await runLoop(engine, interval);
      process.on('SIGINT', () => {
        console.log('\n[Soma] Shutting down...');
        engine.save();
        process.exit(0);
      });
      break;
    }

    case 'repl': {
      await runREPL(engine);
      break;
    }

    default: {
      console.log('Soma Engine — CLI');
      console.log('');
      console.log('Commands:');
      console.log('  query <text>     Ask a question');
      console.log('  reflect          Run autonomous reflection');
      console.log('  status           Show engine status');
      console.log('  who              Self-assessment');
      console.log('  patterns         Pattern analysis');
      console.log('  insights         Generate insights');
      console.log('  loop [ms]        Run autonomous loop');
      console.log('  repl             Interactive conversation');
      console.log('');
      console.log('Running quick self-test...\n');

      const result = await engine.reflect();
      console.log('Reflection result:', result.phases?.act?.output || 'No output');
      console.log(`\nCycle completed in ${result.elapsed}ms`);
      engine.save();
    }
  }
}

// ── Interactive REPL ──────────────────────────────────────────

async function runREPL(engine) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const state = engine.self.currentState();
  console.log(`\n${engine.identity.name || 'Cortex'} Core — Interactive Mode`);
  console.log(`${state.knowledge.nodes || 0} nodes | ${state.mood} | Type /help for commands\n`);

  const prompt = () => {
    rl.question('you > ', async (input) => {
      input = input.trim();
      if (!input) return prompt();

      // Commands
      if (input === '/quit' || input === '/exit') {
        console.log('\nSaving knowledge graph...');
        engine.save();
        console.log('Done.');
        rl.close();
        return;
      }

      if (input === '/help') {
        console.log('\nCommands:');
        console.log('  /status     — Engine status');
        console.log('  /who        — Self-assessment');
        console.log('  /reflect    — Autonomous reflection cycle');
        console.log('  /patterns   — Pattern analysis');
        console.log('  /insights   — Generate insights');
        console.log('  /search <q> — Search knowledge graph');
        console.log('  /save       — Save knowledge graph');
        console.log('  /quit       — Exit');
        console.log('  (anything else is a query)\n');
        return prompt();
      }

      if (input === '/status') {
        const s = engine.status();
        console.log(`\n  State:      ${s.self.mood}`);
        console.log(`  Knowledge:  ${s.knowledge.totalNodes} nodes, ${s.knowledge.totalEdges} edges`);
        console.log(`  Confidence: ${(s.self.confidence || 0).toFixed(2)}`);
        console.log(`  Cycles:     ${s.cycles}`);
        console.log(`  Uptime:     ${Math.round(s.uptime / 1000)}s`);
        console.log(`  Tools:      ${s.tools.filter(t => t.available).map(t => t.name).join(', ')}\n`);
        return prompt();
      }

      if (input === '/who') {
        const who = engine.whoAmI();
        console.log(`\n  ${who.identity} — ${who.nature}`);
        console.log(`  State: ${who.currentState} | Knowledge: ${who.knowledgeSize} nodes`);
        console.log(`  LLM: ${who.llmAvailable ? 'available as tool' : 'unavailable'}\n`);
        return prompt();
      }

      if (input === '/reflect') {
        console.log('\n  Reflecting...');
        const t0 = Date.now();
        const result = await engine.reflect();
        const output = result.phases?.act?.output || 'No insights.';
        console.log(`\ncortex > ${output}\n`);
        console.log(`  (${Date.now() - t0}ms, source: ${result.phases?.act?.source || '?'})\n`);
        return prompt();
      }

      if (input === '/patterns') {
        const analysis = engine.patterns.analyze();
        const report = engine.composer.composePatternReport({ ...analysis, windowDays: 30 });
        console.log(`\ncortex > ${report}\n`);
        return prompt();
      }

      if (input === '/insights') {
        const insights = engine.reasoner.generateInsights();
        if (insights.length === 0) {
          console.log('\ncortex > No insights at this time.\n');
        } else {
          for (const i of insights.slice(0, 5)) {
            console.log(`\n  [${i.priority}] ${i.type}: ${i.content}`);
            if (i.suggestion) console.log(`    → ${i.suggestion}`);
          }
          console.log('');
        }
        return prompt();
      }

      if (input.startsWith('/search ')) {
        const q = input.slice(8).trim();
        const results = engine.search(q, 5);
        if (results.length === 0) {
          console.log(`\ncortex > No results for "${q}"\n`);
        } else {
          console.log(`\ncortex > ${results.length} results for "${q}":`);
          for (const r of results) {
            console.log(`  [${(r.relevance || 0).toFixed(2)}] ${r.node?.title || r.id}`);
          }
          console.log('');
        }
        return prompt();
      }

      if (input === '/save') {
        engine.save();
        console.log('\ncortex > Knowledge graph saved.\n');
        return prompt();
      }

      // Default: query
      const t0 = Date.now();
      const result = await engine.query(input);
      const output = result.phases?.act?.output || 'No response.';
      console.log(`\ncortex > ${output}`);
      console.log(`\n  (${Date.now() - t0}ms, source: ${result.phases?.act?.source || '?'})\n`);
      prompt();
    });
  };

  prompt();
}

// ── Exports ───────────────────────────────────────────────────

module.exports = { SomaEngine, boot, runLoop };

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
