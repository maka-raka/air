module.exports = {
  forbidden: [
    {name:'no-cycles',severity:'error',from:{},to:{circular:true}},
    {name:'delivery-domain-is-pure',severity:'error',from:{path:'^src/delivery/domain/'},
      to:{path:'^(src/delivery/(application|adapters|composition)/|src/policy/|node:|@octokit/|@google-cloud/)'}},
    {name:'policy-domain-is-pure',severity:'error',from:{path:'^src/policy/domain/'},
      to:{path:'^(src/policy/(application|adapters|composition)/|src/delivery/|node:)'}},
    {name:'policy-application-does-not-import-adapters',severity:'error',
      from:{path:'^src/policy/application/'},
      to:{path:'^src/policy/(adapters|composition)/'}},
    {name:'delivery-adapters-do-not-import-composition',severity:'error',
      from:{path:'^src/delivery/adapters/'},
      to:{path:'^src/delivery/composition/'}},
    {name:'production-module-is-exercised-by-tests',severity:'error',
      comment:'Every production module must be reachable from a test; catches dead code and shims.',
      from:{path:'\\.test\\.ts$'},
      to:{path:'^src/',pathNot:'\\.test\\.ts$',reachable:false}},
    {name:'no-production-imports-from-tests',severity:'error',
      from:{path:'^src/.*(?<!\\.test)\\.ts$'},to:{path:'\\.test\\.ts$'}}
  ],
  options:{doNotFollow:{path:'node_modules'},tsConfig:{fileName:'tsconfig.json'}}
};
