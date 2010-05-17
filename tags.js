var sys         = require('sys')

    // Template module dependencies
  , E           = require('./exceptions')
  , Template    = require('./template').Template
  
    // Shorthands
  , getProto    = Object.getPrototypeOf
  , isArray     = Array.isArray;

/**
 * Ninja string is a hack that alows us to change the 
 * contents of the string after we have pushed it into 
 * the rendering output.
 */
function ninjaString( value ){ 
  this.value = value || []; 
}
ninjaString.prototype = { 
  toString: function(){ 
    return this.value.join(""); 
  }
}

/**
 * This is a block tag, like in Django
 * {% block blockname %} 
 *  ... html ... 
 *  ... other tags ... 
 *  ... more html ... 
 * {% endblock %} 
 * 
 */
var validBlockParamRegex = /^\s*([a-zA-Z0-9\-_]+)\s*$/;
exports.block = function( params ){
  var match;
  if( !( match = params.match( validBlockParamRegex ) ) )
    throw new E.TSE( "Invalid block name %s".fmt( params ) );

  this.tagname  = "block";
  this.name     = match[1];
}.tagExpectsClosing();

/**
 * This is an extends tag, like in Django:
 * {% extends "filename.html" %} 
 * 
 * It must ALWAYS be the first thing in the template. 
 * You can also extend dynamically defined templates: 
 * {% extends files.template %} - notice the lack of quotes
 */
var validExtendsParamRegex = /^\s*(["']?)([^.][a-zA-Z0-9\-_.\/]+)\1\s*$/;
exports.extends = function( params, parent, main ) {
  var filepath;
  if( !( filepath = params.match( validExtendsParamRegex ) ) )
    throw new E.TSE( "Invalid filename in extends tag: '%s'".fmt( params ) );
  
  // This code is run before the token is pushed to the children
  // array so we can safely check for preceding tokens like this
  if( parent.children.length )
    throw new E.TSE("Extends tag is not at the beginning of template '%s'".fmt( parent.filepath ));

  // If template is blocking increase the blocked counter onthe main template
  if( filepath[1] === "'" || filepath[1] === '"' ) {
    this.template = new Template( filepath[2], main );
    this.template.load();
  }
  // Filename is in a context var - parse template on render
  else {
    this.lazy = filepath[2];
    this.main = main;
  }
    
}.tagRender(function(context, callback, blocks ) {
  if( this.lazy ) {
    var filepath;
    if( !( filepath = context.getPath( this.lazy ) ) )
      throw new E.TE( "Variable '%s' is not a valid filename".fmt( this.lazy ) );

    new Template( filepath, this.main ).load(function( err, template ){
      if( err )
        callback( err, null );
      else
        template.render( context, callback, blocks );
    });
  }
  else
    return [this.template.render( context, callback, blocks )];
})


/**
 * This is an include tag, like in Django:
 * {% include "filename.html" %} 
 *  
 * The include does not render any blocks defined in it. 
 * 
 * You can also include dynamically defined templates: 
 * {% include files.template %} - notice the lack of quotes
 */
exports.include = function( params, parent, main ) {
  var filepath;
  if( !( filepath = params.match( validExtendsParamRegex ) ) )
    throw new E.TSE( "Invalid filename in include tag: '%s'".fmt( params ) );
  
  // If template is blocking it will bubble up to this token's parent.
  if( filepath[1] === "'" || filepath[1] === '"' ) {
    this.template = new Template( filepath[2], main );
    this.template.load();
  }
  // Filename is in a context var - parse template on render
  else {
    this.lazy = filepath[2];
    this.main = main;
  }

}.tagRender(function( context ){
    var filepath;
    if( this.lazy ) {
      if( !( filepath = context.getPath( this.lazy ) ) )
        throw new E.TE( "Variable '%s' is not a valid filename".fmt( lazy ) );

      var ns = new ninjaString(), frozen = context.clone();
      
      new Template( filepath, this.main ).load( function( err, template ){
        if( template ) 
          ns.value = template.render( frozen );
      });
      return ns;
    }
    else 
      return this.template.render( context );
});

/**
 * This is a for tag, like in Django:
 * {% for val in vals %} ... {% endfor %}
 */
var validForParamRegex = /^(\w+) *(, *(\w+))? +in +(\w+([.]\w+)*)$/;
exports["for"] = function( params, parent ){
  var matches;
  if( !( matches = params.match(validForParamRegex) ) )
    throw new E.TSE( "Invalid 'for' tag syntax: '%s'".fmt(params) );
  
  this.var1   = matches[1], 
  this.var2   = matches[3], 
  this.lookup = matches[4];
  
  if( !isNaN( +this.var1 ) || (this.var2 && !isNaN( +this.var2 )) || !isNaN( +this.lookup ) )
    throw new E.TSE( "Invalid variable names in '{% for %s %}'".fmt(params) );
  
  this.tagname  = "for";
  
}.tagRender(function( context ){
  var iter, i, j=0, r
    , ctx = { forloop:{} }
    , output = []
    , var1 = this.var1
    , var2 = this.var2
    , lookup = this.lookup
    , render = getProto(this).render;
  
  if( !( iter = context.getPath( lookup ) ) )
    return ""; // iterable not found; render nothing
  
  context.push( ctx );
  
  if( isArray( iter ) )
    for( i=0, j=iter.length; i<j; ++i ) {
      ctx[ var1 ] = iter[ i ];
      var2 && ( ctx[ var2 ] = i );
      output = output.concat( render.call( this, context ) );
    }
    
  else if( typeof iter === 'object' )
  
    for( i in iter ) {
      if( !iter.hasOwnProperty(i) ) continue;
      ctx[ var1 ] = iter[ i ];
      var2 && ( ctx[ var2 ] = i );
      output = output.concat( render.call( this, context ) );
    }
    
  else if( typeof iter === 'string' )
  
   for( i in iter ) {
     ctx[ var1 ] = iter[ i ];
     var2 && ( ctx[ var2 ] = j++ );
     output = output.concat( render.call( this, context ) );
   }
   
  else throw new E.TE( "'%s' is not a valid variable for looping".fmt( lookup ) );

  context.pop();
  return output;
  
}).tagExpectsClosing();

/**
 * This is an IF tag, like in Django. 
 * It can contain 'else' and 'else if' tags inside.
 */
var validIfParamRegex = /^(\w+(\.\w+)*)( ?(<|>|==|>=|<=|\!=| in ) ?(\w+(\.\w+)*))?$/;
exports['if'] = function( params, parent ) {
  var matches;
  this.branches=[];

  if( !( matches = params.match(validIfParamRegex) ) )
    throw new E.TSE( "Invalid 'if' tag syntax: '%s'".fmt(params) );
  
  this.var1     = matches[1]; 
  this.var2     = matches[5]; 
  this.operator = matches[4] && matches[4].trim();
  
}.tagCompile(function() {
  var c
    , i=0
    , curr=0
    , lastToken = false
    , children = this.children
    , branches = this.branches
    , j = children.length;
  
  branches.push({ v1:this.var1, v2:this.var2, op:this.operator, start:0, end:j });
  for( ; i<j; i++ ) {
    c = children[i];
    if( c.tagname === 'else' ) {
      
      if( lastToken ) throw new E.TSE("Ivalid placement of 'else' tag within and 'if' block");
      if( c.plain ) lastToken = true; // a plain else tag must be the last one in the if block
        
      branches[curr].end = i;
      // start is i+1 because we skip this else token - it doesn't render
      branches.push({ v1:c.var1, v2:c.var2, op:c.operator, start:i+1, end:j });
      ++curr;
    }
  }
}).tagRender(function( context ){
  var i, j, op, v1, v2, branch
    , branches = this.branches
    , found  = false;
  
  for( i=0, j=branches.length; i<j; ++i  ) {
    branch = branches[i];
    v1 = branch.v1;
    v2 = branch.v2;
    op = branch.op;
    
    v1 = !isNaN(+v1) ? (+v1) : context.getPath( v1 );
    if(v2) v2 = !isNaN(+v2) ? (+v2) : context.getPath( v2 );
    if( op )
      found = 
          op === "==" ? v1 === v2
        : op === "<=" ? v1 <=  v2
        : op === ">=" ? v1 >=  v2
        : op === "!=" ? v1 <=  v2
        : op === "<"  ? v1  <  v2
        : op === ">"  ? v1  >  v2
        // Execute 'in' operator (only option left)
        : isArray(v2) || typeof v2 === 'string' ? v2.indexOf(v1) > -1
        : typeof v2 === 'object' ? v1 in v2
        : false;

    else if( v1 )
      found = true;
    
    if( found )
      break;
  }
  
  if( !found )
    return [];

  return getProto(this).render.call(this, context, this.children.slice( branch.start, branch.end ));
}).tagExpectsClosing();

/**
 * This is an else (with an optional if) tag.
 */
var removeIfRegex = /^if +/;
exports['else'] = function( params, parent ){
  var matches, branches=[];
  
  if( parent.tagname !== 'if' )
    throw new E.TSE( "'else' tag encountered outside an 'if' block" );

  if( params === "" ) {
    this.plain = true; // This is a plain else tag, not an 'else if'
    this.var1  = true;
    return;
  }
  
  params = params.replace(removeIfRegex, "");
  if( !( matches = params.match(validIfParamRegex) ) )
    throw new E.TSE( "Invalid 'else if' tag syntax: '%s'".fmt(params) );
  
  this.var1      = matches[1]; 
  this.var2      = matches[5]; 
  this.operator  = matches[4] && matches[4].trim();
};