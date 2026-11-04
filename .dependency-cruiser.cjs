module.exports = {
  forbidden: [
    {name:'no-cycles',severity:'error',from:{},to:{circular:true}},
    {name:'delivery-is-pure',severity:'error',from:{path:'^src/delivery/'},
      to:{path:'^(src/github/|src/policy/|node:|@octokit/|@google-cloud/)'}},
    {name:'policy-domain-is-pure',severity:'error',from:{path:'^src/policy/domain/'},
      to:{path:'^(src/policy/(application|adapters|composition)/|src/github/|node:)'}},
    {name:'policy-application-does-not-import-adapters',severity:'error',
      from:{path:'^src/policy/application/'},
      to:{path:'^src/policy/(adapters|composition)/'}},
    {name:'no-production-imports-from-tests',severity:'error',
      from:{path:'^src/.*(?<!\\.test)\\.ts$'},to:{path:'\\.test\\.ts$'}}
  ],
  options:{doNotFollow:{path:'node_modules'},tsConfig:{fileName:'tsconfig.json'}}
};
