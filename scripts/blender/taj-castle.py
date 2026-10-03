# 花园城堡（规格书 §10.2 阶段 12）：Gokul.Saravanappriyan 的 "Taj mahal"（CC BY 4.0，83 万面、无贴图）→ 三级 glb，输出到 assets/raw/built/。
#   缩放 0.52 米 / 单位（台基约 117 米见方），台基底面中心放到原点；
#   分成大理石和银顶两个网格：主穹顶整块是银的；主体上 82 单位以上（凉亭的小穹顶、尖饰）、宣礼塔 100 单位以上（塔顶凉亭）的面也算银顶；
#   大理石每个顶点写 _part（0 主体、1 台基、2 宣礼塔），着色器按它分色（主体象牙白、台基偏暖）；
#   环境光遮蔽烘进顶点色（Cycles，OptiX，AO 距离 4 米）：凹进去的拱门、檐下、塔脚变暗，着色器再按 AO 把凹处染冷（拱门内部偏冷）；
#   三级：近处约 25 万三角、中档和倒影约 6 万、远景替身约 8 千（按部件分预算：主体、宣礼塔、台基、穹顶）。
# 用法：blender --background --python scripts/blender/taj-castle.py
import bpy, bmesh, os, sys, time
from mathutils import Vector

ROOT = os.path.abspath( os.path.join( os.path.dirname( __file__ ), '..', '..' ) )
SOURCE = os.path.join( ROOT, 'assets', 'raw', 'sketchfab', 'taj-gokul', 'scene.gltf' )
BUILT = os.path.join( ROOT, 'assets', 'raw', 'built' )
SCALE = 0.52
started = time.time()

def selectOnly( objects ):

	bpy.ops.object.select_all( action = 'DESELECT' )
	for item in objects:
		item.select_set( True )
	bpy.context.view_layer.objects.active = objects[ 0 ]

def triangleCount( item ):

	return sum( len( polygon.vertices ) - 2 for polygon in item.data.polygons )

bpy.ops.wm.read_factory_settings( use_empty = True )
bpy.ops.import_scene.gltf( filepath = SOURCE )
meshes = [ item for item in bpy.data.objects if item.type == 'MESH' ]
print( f'读入 { len( meshes ) } 个网格，{ sum( triangleCount( item ) for item in meshes ) } 三角' )

# 全部烘进世界坐标、清掉父子关系
for item in meshes:
	world = item.matrix_world.copy()
	item.parent = None
	item.matrix_world = world
selectOnly( meshes )
bpy.ops.object.transform_apply( location = True, rotation = True, scale = True )
for item in list( bpy.data.objects ):
	if item.type != 'MESH':
		bpy.data.objects.remove( item )

# 台基（Object007）的包围盒定原点：底面中心
plinthParts = [ item for item in meshes if item.name.startswith( 'Object007' ) ]
low = Vector( ( 1e9, 1e9, 1e9 ) )
high = Vector( ( - 1e9, - 1e9, - 1e9 ) )
for item in plinthParts:
	for vertex in item.data.vertices:
		low = Vector( map( min, low, vertex.co ) )
		high = Vector( map( max, high, vertex.co ) )
origin = Vector( ( ( low.x + high.x ) / 2, ( low.y + high.y ) / 2, low.z ) )
print( f'台基 { ( high.x - low.x ) * SCALE:.1f} × { ( high.y - low.y ) * SCALE:.1f} 米，原点 { origin }' )

# 每个网格：部件号、银顶的面
def kindOf( name ):

	if name.startswith( 'Sphere001' ):
		return 'dome'
	if name.startswith( 'Object007' ):
		return 'plinth'
	if name.startswith( 'Object012' ):
		return 'minaret'
	return 'body'

# 两个材质的属性要不一样（颜色、金属度），不然 scripts/opt.mjs 的去重会把它们合成一个，大理石和银顶就分不开了
def newMaterial( name, baseColor, metallic ):

	material = bpy.data.materials.new( name )
	material.use_nodes = True
	shader = material.node_tree.nodes.get( 'Principled BSDF' )
	shader.inputs[ 'Base Color' ].default_value = baseColor
	shader.inputs[ 'Metallic' ].default_value = metallic
	shader.inputs[ 'Roughness' ].default_value = 0.2 if metallic else 0.35
	return material

partCode = { 'body': 0, 'plinth': 1, 'minaret': 2 }
silverFrom = { 'body': 82, 'minaret': 100 }

for item in meshes:
	kind = kindOf( item.name )
	mesh = item.data
	# 先移到原点、缩放
	for vertex in mesh.vertices:
		vertex.co = ( vertex.co - origin ) * SCALE
	attribute = mesh.attributes.new( '_part', 'FLOAT', 'POINT' )
	for index in range( len( mesh.vertices ) ):
		attribute.data[ index ].value = partCode.get( kind, 0 )
	# 材质：两个槽，0 大理石、1 银顶
	mesh.materials.clear()
	marble = bpy.data.materials.get( '大理石' ) or newMaterial( '大理石', ( 0.94, 0.92, 0.88, 1 ), 0 )
	silver = bpy.data.materials.get( '银顶' ) or newMaterial( '银顶', ( 0.9, 0.92, 0.95, 1 ), 1 )
	mesh.materials.append( marble )
	mesh.materials.append( silver )
	threshold = silverFrom.get( kind )
	for polygon in mesh.polygons:
		if kind == 'dome':
			polygon.material_index = 1
		elif threshold is not None and ( polygon.center.z / SCALE + origin.z ) > threshold:
			polygon.material_index = 1
		else:
			polygon.material_index = 0
	item.name = kind + '·' + item.name

# 按部件合成四个对象（主体、宣礼塔、台基、穹顶），各自减面
groups = {}
for item in meshes:
	groups.setdefault( kindOf( item.name.split( '·', 1 )[ 1 ] ), [] ).append( item )
merged = {}
for kind, items in groups.items():
	selectOnly( items )
	bpy.ops.object.join()
	joined = bpy.context.view_layer.objects.active
	joined.name = kind
	mesh = bmesh.new()
	mesh.from_mesh( joined.data )
	bmesh.ops.remove_doubles( mesh, verts = mesh.verts, dist = 0.001 )
	mesh.to_mesh( joined.data )
	mesh.free()
	merged[ kind ] = joined
	print( f'{ kind }：{ triangleCount( joined ) } 三角' )

def decimate( item, targetTriangles ):

	current = triangleCount( item )
	if current <= targetTriangles:
		return
	modifier = item.modifiers.new( '减面', 'DECIMATE' )
	modifier.decimate_type = 'COLLAPSE'
	modifier.ratio = targetTriangles / current
	modifier.use_collapse_triangulate = True
	selectOnly( [ item ] )
	bpy.ops.object.modifier_apply( modifier = modifier.name )
	print( f'  { item.name }：{ current } → { triangleCount( item ) } 三角' )

def copyOf( item, name ):

	copy = item.copy()
	copy.data = item.data.copy()
	bpy.context.scene.collection.objects.link( copy )
	copy.name = name
	return copy

# AO：Cycles，能用 OptiX 就用显卡
def setupCycles():

	scene = bpy.context.scene
	scene.render.engine = 'CYCLES'
	scene.cycles.samples = 48
	device = 'CPU'
	try:
		preferences = bpy.context.preferences.addons[ 'cycles' ].preferences
		preferences.compute_device_type = 'OPTIX'
		preferences.get_devices()
		for item in preferences.devices:
			item.use = item.type == 'OPTIX'
		if any( item.use for item in preferences.devices ):
			device = 'GPU'
	except Exception as error:
		print( f'OptiX 用不了，用 CPU 烘：{ error }' )
	scene.cycles.device = device
	if scene.world is None:
		scene.world = bpy.data.worlds.new( '烘焙' )
	scene.world.light_settings.distance = 4
	scene.render.bake.target = 'VERTEX_COLORS'
	print( f'AO 用 { device } 烘' )

# 一级：每个部件按预算减面 → 合成一个对象 → 烘 AO（整座一起烘，部件之间互相挡光）→ 按材质拆成大理石、银顶 → 导出
def buildLevel( name, budget, bake ):

	parts = []
	for kind, item in merged.items():
		copy = copyOf( item, f'{ name }·{ kind }' )
		decimate( copy, budget[ kind ] )
		parts.append( copy )
	selectOnly( parts )
	bpy.ops.object.join()
	castle = bpy.context.view_layer.objects.active
	castle.name = name
	attribute = castle.data.color_attributes.new( 'Col', 'BYTE_COLOR', 'POINT' )
	castle.data.color_attributes.active_color = attribute
	if bake:
		selectOnly( [ castle ] )
		bakeStarted = time.time()
		bpy.ops.object.bake( type = 'AO' )
		print( f'  { name }：AO 烘完（{ time.time() - bakeStarted:.0f} 秒）' )
	else:
		# 替身不烘：从近处那一级按最近的面插值转过来
		transfer = castle.modifiers.new( '转 AO', 'DATA_TRANSFER' )
		transfer.object = bpy.data.objects[ 'taj-castle' ]
		transfer.use_vert_data = True
		transfer.data_types_verts = { 'COLOR_VERTEX' }
		transfer.vert_mapping = 'POLYINTERP_NEAREST'
		selectOnly( [ castle ] )
		bpy.ops.object.modifier_apply( modifier = transfer.name )
	castle.data.validate()
	os.makedirs( BUILT, exist_ok = True )
	path = os.path.join( BUILT, name + '.glb' )
	selectOnly( [ castle ] )
	bpy.ops.export_scene.gltf(
		filepath = path, export_format = 'GLB', use_selection = True,
		export_vertex_color = 'ACTIVE', export_attributes = True, export_yup = True,
		export_materials = 'EXPORT', export_tangents = False,
	)
	print( f'导出 { path }：{ triangleCount( castle ) } 三角' )
	return castle

setupCycles()
buildLevel( 'taj-castle', { 'body': 150000, 'minaret': 50000, 'plinth': 30000, 'dome': 20000 }, True )
buildLevel( 'taj-castle-lod1', { 'body': 34000, 'minaret': 12000, 'plinth': 8000, 'dome': 6000 }, True )
buildLevel( 'taj-castle-lod2', { 'body': 4200, 'minaret': 1600, 'plinth': 1200, 'dome': 1000 }, False )
print( f'全部完成，用时 { time.time() - started:.0f} 秒' )
